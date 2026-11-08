use murmur_core::{
    commit_post, decode, encode, read_metadata, validate_schema, RecordIo, VeilidRecord,
};
use murmur_model::{
    next_index, validate_profile, Feed, FeedPage, Metadata, ModelError, PageCursor, Post,
    OWNER_SUBKEYS,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{oneshot, watch, Mutex, Semaphore},
    task::JoinHandle,
};
use veilid_core::{
    api_startup, DHTSchema, KeyPair, RecordKey, RoutingContext, VeilidAPI, VeilidAPIError,
    VeilidConfig, VeilidUpdate, CRYPTO_KIND_VLD0,
};

#[derive(Serialize, Deserialize)]
pub struct Config {
    pub author_name: String,
    pub bio: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub record_key: Option<RecordKey>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub writer: Option<KeyPair>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Error {
    pub status: u16,
    pub error: String,
}

impl Error {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            error: message.into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::new(502, message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<ModelError> for Error {
    fn from(error: ModelError) -> Self {
        let status = match error {
            ModelError::InvalidContent => 400,
            ModelError::InvalidProfile => 500,
            ModelError::InvalidSchema => 502,
            ModelError::IndexExhausted => 409,
            ModelError::InvalidCursor => 400,
            ModelError::CursorExpired => 410,
        };
        Self::new(status, error.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        veilid_core::tracing::error!(%error, "local I/O failure");
        Self::new(500, format!("local I/O failure: {error}"))
    }
}

impl From<VeilidAPIError> for Error {
    fn from(error: VeilidAPIError) -> Self {
        murmur_core::Error::from(error).into()
    }
}

impl From<murmur_core::Error> for Error {
    fn from(error: murmur_core::Error) -> Self {
        use murmur_core::Error as CoreError;
        let status = match error {
            CoreError::Model(error) => return error.into(),
            CoreError::NetworkTimeout | CoreError::Deadline => 504,
            CoreError::Unavailable => 503,
            CoreError::NotFound => 404,
            CoreError::Serialization => 500,
            CoreError::WriteConflict => 409,
            CoreError::IncompleteOwnerKey => {
                return Self::new(
                    400,
                    "use the complete server RecordKey, including its encryption key",
                )
            }
            _ => 502,
        };
        Self::new(status, error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub async fn deadline<T>(future: impl Future<Output = Result<T>>, seconds: u64) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(seconds), future)
        .await
        .map_err(|_| Error::new(504, "operation timed out; retry later"))?
}

pub fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        Error::new(
            500,
            format!(
                "invalid {} (JSON or identity at line {}, column {})",
                path.display(),
                error.line(),
                error.column(),
            ),
        )
    })
}

pub fn save_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| Error::new(500, format!("cannot serialize local state: {error}")))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    File::open(path.parent().ok_or("state path has no parent")?)?.sync_all()?;
    Ok(())
}

fn validate_config(config: &Config) -> Result<()> {
    validate_profile(&config.author_name, &config.bio)?;
    match (&config.record_key, &config.writer) {
        (None, None) => Ok(()),
        (Some(key), Some(writer))
            if key.kind() == writer.kind() && key.kind() == CRYPTO_KIND_VLD0 =>
        {
            Ok(())
        }
        _ => Err(Error::new(
            500,
            "invalid or incomplete local identity; refusing to replace it",
        )),
    }
}

pub fn export_identity(directory: &Path, output: &Path, passphrase: &str) -> Result<()> {
    let config: Config = load_json(&directory.join("murmur_config.json"))?
        .ok_or_else(|| Error::new(400, "no local identity to export"))?;
    validate_config(&config)?;
    let pending: Option<Post> = load_json(&directory.join("pending-post.json"))?;
    let credentials = murmur_core::credentials::Credentials {
        version: 1,
        record_key: config.record_key.ok_or("no local feed key to export")?,
        writer: config.writer.ok_or("no local writer to export")?,
        profile: Metadata {
            author_name: config.author_name,
            bio: config.bio,
            latest_post_index: pending.as_ref().and_then(|post| post.index.checked_sub(1)),
        },
        pending,
        history: vec![],
    };
    let envelope = credentials.seal(passphrase)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)?;
    file.write_all(&envelope)?;
    file.sync_all()?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    File::open(parent)?.sync_all()?;
    Ok(())
}

async fn tracked<T: Send + 'static>(
    workers: &Mutex<Vec<JoinHandle<()>>>,
    work: impl Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    let mut workers = workers.lock().await;
    workers.retain(|worker| !worker.is_finished());
    workers.push(tokio::spawn(async move {
        if tx.send(work.await).is_err() {
            veilid_core::tracing::debug!("feed reader disconnected; completed DHT cleanup");
        }
    }));
    drop(workers);
    rx.await
        .map_err(|_| Error::new(500, "feed worker failed"))?
}

pub fn validate_content(content: &str) -> Result<()> {
    murmur_model::validate_content(content).map_err(Into::into)
}

pub struct Node {
    pub api: VeilidAPI,
    context: RoutingContext,
    pub config: Config,
    pub directory: PathBuf,
    ready: watch::Receiver<bool>,
    operations: Mutex<()>,
    readers: Semaphore,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl Node {
    pub async fn start(
        directory: PathBuf,
        p2p_port: u16,
        mut stop: watch::Receiver<bool>,
    ) -> Result<Arc<Self>> {
        let path = directory.join("murmur_config.json");
        let mut config = load_json::<Config>(&path)?.unwrap_or(Config {
            author_name: "Murmur author".into(),
            bio: String::new(),
            record_key: None,
            writer: None,
        });
        validate_config(&config)?;
        let storage = directory.to_str().ok_or("data directory must be UTF-8")?;
        let mut veilid_config =
            VeilidConfig::new("murmur", "murmur", "org", Some(storage), Some(storage));
        veilid_config.protected_store.always_use_insecure_storage = true;
        veilid_config.network.protocol.udp.listen_address = format!(":{p2p_port}");
        veilid_config.network.protocol.tcp.listen_address = format!(":{p2p_port}");
        veilid_config.network.protocol.ws.listen = false;
        let (ready_tx, ready) = watch::channel(false);
        let api = api_startup(
            Arc::new(move |update| {
                if let VeilidUpdate::Attachment(attachment) = update {
                    ready_tx.send_replace(attachment.public_internet_ready);
                }
            }),
            veilid_config,
        )
        .await?;
        let initialize = async {
            api.attach().await?;
            let mut attachment = ready.clone();
            attachment
                .wait_for(|ready| *ready)
                .await
                .map_err(|_| Error::new(503, "Veilid stopped before network attachment"))?;
            let context = api.routing_context()?;
            if let (Some(key), Some(writer)) = (&config.record_key, &config.writer) {
                let descriptor = context
                    .open_dht_record(key.clone(), Some(writer.clone()), None)
                    .await?;
                validate_schema(descriptor.ref_schema())?;
                if descriptor.owner() != writer.key() {
                    return Err(Error::new(500, "writer does not own the configured record"));
                }
            } else {
                let descriptor = context
                    .create_dht_record(
                        CRYPTO_KIND_VLD0,
                        DHTSchema::smpl(OWNER_SUBKEYS, vec![])?,
                        None,
                    )
                    .await?;
                config.record_key = Some(descriptor.key());
                config.writer = Some(
                    descriptor
                        .owner_keypair()
                        .ok_or("created record has no writer")?,
                );
                save_json(&path, &config)?;
            }
            Ok(context)
        };
        let initialized = tokio::select! {
            result = deadline(initialize, 120) => result,
            _ = stop.wait_for(|stop| *stop) => Err(Error::new(503, "startup stopped")),
        };
        let context = match initialized {
            Ok(context) => context,
            Err(error) => {
                api.shutdown().await;
                return Err(error);
            }
        };
        let node = Arc::new(Self {
            api,
            context,
            config,
            directory,
            ready,
            operations: Mutex::new(()),
            readers: Semaphore::new(8),
            workers: Mutex::new(Vec::new()),
        });
        let profile = tokio::select! {
            result = node.initialize_profile() => result,
            _ = stop.wait_for(|stop| *stop) => Err(Error::new(503, "startup stopped")),
        };
        if let Err(error) = profile {
            node.api.clone().shutdown().await;
            return Err(error);
        }
        Ok(node)
    }

    pub fn key(&self) -> RecordKey {
        self.config
            .record_key
            .as_ref()
            .expect("initialized identity")
            .clone()
    }

    fn own_record(&self) -> VeilidRecord<'_> {
        VeilidRecord {
            context: &self.context,
            key: self.key(),
            writer: self.config.writer.clone(),
        }
    }

    fn check_ready(&self) -> Result<()> {
        if !*self.ready.borrow() {
            return Err(Error::new(
                503,
                "Veilid is detached; retry after network recovery",
            ));
        }
        Ok(())
    }

    async fn initialize_profile(&self) -> Result<()> {
        let record = self.own_record();
        let mut metadata = match record.get(0).await? {
            Some(bytes) => decode::<Metadata>(&bytes)?,
            None => Metadata {
                author_name: self.config.author_name.clone(),
                bio: self.config.bio.clone(),
                latest_post_index: None,
            },
        };
        metadata.author_name = self.config.author_name.clone();
        metadata.bio = self.config.bio.clone();
        record.set(0, encode(&metadata)?).await?;
        self.recover(&record).await
    }

    async fn recover(&self, record: &impl RecordIo) -> Result<()> {
        let path = self.directory.join("pending-post.json");
        if let Some(post) = load_json::<Post>(&path)? {
            validate_content(&post.content)?;
            let metadata = read_metadata(record).await?;
            commit_post(record, &metadata, &post).await?;
            fs::remove_file(path)?;
            File::open(&self.directory)?.sync_all()?;
        }
        Ok(())
    }

    pub async fn publish(&self, content: String) -> Result<Post> {
        validate_content(&content)?;
        let _operation = self.operations.lock().await;
        self.check_ready()?;
        let record = self.own_record();
        self.recover(&record).await?;
        let metadata = read_metadata(&record).await?;
        let post = Post {
            index: next_index(metadata.latest_post_index)?,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::new(500, "system clock predates Unix epoch"))?
                .as_secs(),
            content,
        };
        let path = self.directory.join("pending-post.json");
        save_json(&path, &post)?;
        commit_post(&record, &metadata, &post).await?;
        fs::remove_file(path)?;
        File::open(&self.directory)?.sync_all()?;
        Ok(post)
    }

    pub async fn feed(self: Arc<Self>, key: RecordKey) -> Result<Feed> {
        self.feed_page(key, None).await.map(|page| page.feed)
    }

    pub async fn feed_page(
        self: Arc<Self>,
        key: RecordKey,
        cursor: Option<PageCursor>,
    ) -> Result<FeedPage> {
        tracked(&self.workers, {
            let node = self.clone();
            async move { node.read_page(key, cursor).await }
        })
        .await
    }

    async fn read_page(&self, key: RecordKey, cursor: Option<PageCursor>) -> Result<FeedPage> {
        let _reader = self
            .readers
            .try_acquire()
            .map_err(|_| Error::new(503, "too many feed requests; retry later"))?;
        let _operation = deadline(async { Ok(self.operations.lock().await) }, 30).await?;
        self.check_ready()?;
        murmur_core::read_feed_page(&self.context, Some(&self.key()), key, cursor)
            .await
            .map_err(Into::into)
    }

    pub async fn shutdown(&self) {
        let workers = std::mem::take(&mut *self.workers.lock().await);
        for worker in workers {
            if let Err(error) = worker.await {
                veilid_core::tracing::error!(%error, "feed worker failed during shutdown");
            }
        }
        let _operation = self.operations.lock().await;
        if let Err(error) = self.context.close_dht_record(self.key()).await {
            let error: Error = error.into();
            veilid_core::tracing::error!(%error, "cannot close own record");
        }
        self.api.clone().shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(index: u64) -> Post {
        Post {
            index,
            timestamp: 42,
            content: format!("post {index}"),
        }
    }

    #[test]
    fn exports_encrypted_pending_identity_without_overwriting_backups() {
        let directory = tempfile::tempdir().unwrap();
        let zero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let config = Config {
            author_name: "Native author".into(),
            bio: "".into(),
            record_key: Some(format!("VLD0:{zero}:{zero}").parse().unwrap()),
            writer: Some(format!("VLD0:{zero}:{zero}").parse().unwrap()),
        };
        save_json(&directory.path().join("murmur_config.json"), &config).unwrap();
        save_json(&directory.path().join("pending-post.json"), &post(3)).unwrap();
        let output = directory.path().join("identity.murmur");
        export_identity(directory.path(), &output, "disposable backup passphrase").unwrap();
        let bytes = fs::read(&output).unwrap();
        let restored =
            murmur_core::credentials::Credentials::open(&bytes, "disposable backup passphrase")
                .unwrap();
        assert_eq!(Some(restored.record_key), config.record_key);
        assert_eq!(Some(restored.writer), config.writer);
        assert_eq!(restored.pending, Some(post(3)));
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(export_identity(directory.path(), &output, "another passphrase").is_err());
        assert_eq!(fs::read(output).unwrap(), bytes);
    }

    #[test]
    fn rejects_incomplete_identity() {
        let mut config = Config {
            author_name: "Test".into(),
            bio: String::new(),
            record_key: None,
            writer: None,
        };
        assert!(validate_config(&config).is_ok());
        config.author_name = " ".into();
        assert!(validate_config(&config).is_err());
        assert!(serde_json::from_str::<Config>(
            r#"{"author_name":"x","bio":"","record_key":"invalid","writer":null}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Config>(r#"{"author_name":"x","bio":""}"#).is_err());
        config.author_name = "Test".into();
        config.record_key = Some(
            "VLD0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                .parse()
                .unwrap(),
        );
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn private_state_roundtrips_and_corrupt_state_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pending-post.json");
        assert!(load_json::<Post>(&path).unwrap().is_none());
        save_json(&path, &post(3)).unwrap();
        assert_eq!(load_json::<Post>(&path).unwrap(), Some(post(3)));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::write(&path, b"broken").unwrap();
        assert!(load_json::<Post>(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
    }

    #[tokio::test]
    async fn deadlines_report_failure_instead_of_waiting_forever() {
        let result = deadline(async { std::future::pending::<Result<()>>().await }, 0).await;
        assert_eq!(result.unwrap_err().status, 504);
    }

    #[tokio::test]
    async fn cancelled_reader_still_finishes_tracked_work_and_cleanup() {
        let workers = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let (cleaned_tx, cleaned_rx) = oneshot::channel();
        let registry = workers.clone();
        let caller = tokio::spawn(async move {
            tracked(&registry, async move {
                started_tx.send(()).unwrap();
                finish_rx.await.unwrap();
                cleaned_tx.send(()).unwrap();
                Ok(())
            })
            .await
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        finish_tx.send(()).unwrap();
        cleaned_rx.await.unwrap();
        for worker in workers.lock().await.drain(..) {
            worker.await.unwrap();
        }
    }
}
