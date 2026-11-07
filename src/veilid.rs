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
    api_startup, AllowOffline, DHTSchema, KeyPair, RecordKey, RoutingContext, SetDHTValueOptions,
    VeilidAPI, VeilidAPIError, VeilidConfig, VeilidUpdate, CRYPTO_KIND_VLD0,
};

const CAPACITY: u64 = 100;
const FEED_LIMIT: u64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Metadata {
    pub author_name: String,
    pub bio: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub latest_post_index: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Post {
    pub index: u64,
    pub timestamp: u64,
    pub content: String,
}

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

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        veilid_core::tracing::error!(%error, "local I/O failure");
        Self::new(500, format!("local I/O failure: {error}"))
    }
}

impl From<VeilidAPIError> for Error {
    fn from(error: VeilidAPIError) -> Self {
        let (status, message) = match error {
            VeilidAPIError::Timeout => (504, "Veilid request timed out"),
            VeilidAPIError::TryAgain { .. } | VeilidAPIError::NoConnection { .. } => {
                (503, "Veilid network unavailable; retry later")
            }
            VeilidAPIError::KeyNotFound { .. } => (404, "DHT record not found"),
            _ => (502, "Veilid operation failed"),
        };
        // Avoid logging API arguments, which may contain writer credentials.
        veilid_core::tracing::warn!(status, message);
        Self::new(status, message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize)]
pub struct Feed {
    pub record_key: String,
    pub metadata: Metadata,
    pub posts: Vec<Post>,
}

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

trait RecordIo {
    fn get(&self, subkey: u32) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;
    fn set(&self, subkey: u32, data: Vec<u8>) -> impl Future<Output = Result<()>> + Send;
}

fn validate_config(config: &Config) -> Result<()> {
    if config.author_name.trim().is_empty()
        || config.author_name.chars().count() > 80
        || config.bio.chars().count() > 280
    {
        return Err(Error::new(
            500,
            "profile needs a nonblank name (max 80 characters) and bio (max 280)",
        ));
    }
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

fn validate_schema(schema: &DHTSchema) -> Result<()> {
    match schema {
        DHTSchema::SMPL(schema) if schema.o_cnt() == 101 && schema.members().is_empty() => Ok(()),
        _ => Err("incompatible feed schema (expected 101 owner-only SMPL subkeys)".into()),
    }
}

fn remote_key(own: &RecordKey, requested: &RecordKey) -> Result<bool> {
    if own.opaque() != requested.opaque() {
        return Ok(true);
    }
    if own != requested {
        return Err(Error::new(
            400,
            "use the complete server RecordKey, including its encryption key",
        ));
    }
    Ok(false)
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

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| "invalid feed JSON".into())
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| Error::new(500, "JSON serialization failed"))
}

async fn read_metadata(record: &impl RecordIo) -> Result<Metadata> {
    let bytes = record.get(0).await?.ok_or("feed metadata is missing")?;
    let metadata: Metadata = decode(&bytes)?;
    if metadata.author_name.trim().is_empty()
        || metadata.author_name.chars().count() > 80
        || metadata.bio.chars().count() > 280
    {
        return Err("invalid feed profile".into());
    }
    Ok(metadata)
}

async fn read_posts(record: &impl RecordIo, metadata: &Metadata) -> Result<Vec<Post>> {
    let mut posts = Vec::new();
    for index in recent_indexes(metadata.latest_post_index) {
        let bytes = record
            .get(post_subkey(index))
            .await?
            .ok_or("feed is incomplete; retry later")?;
        let post: Post = decode(&bytes)?;
        if post.index != index {
            return Err("feed changed while reading; retry later".into());
        }
        validate_content(&post.content).map_err(|_| Error::new(502, "invalid feed post"))?;
        posts.push(post);
    }
    Ok(posts)
}

async fn commit_post(record: &impl RecordIo, metadata: &Metadata, post: &Post) -> Result<()> {
    if metadata.latest_post_index != Some(post.index)
        && next_index(metadata.latest_post_index)? != post.index
    {
        return Err("pending post is out of sequence; manual recovery required".into());
    }
    let slot = post_subkey(post.index);
    let existing = record
        .get(slot)
        .await?
        .map(|bytes| decode::<Post>(&bytes))
        .transpose()?;
    if let Some(existing) = &existing {
        if existing.index >= post.index && existing != post {
            return Err("conflicting post; manual recovery required".into());
        }
    }
    if metadata.latest_post_index == Some(post.index) {
        return if existing.as_ref() == Some(post) {
            Ok(())
        } else {
            Err("published metadata has no matching post; manual recovery required".into())
        };
    }
    if existing.as_ref() != Some(post) {
        record.set(slot, encode(post)?).await?;
    }
    let mut updated = metadata.clone();
    updated.latest_post_index = Some(post.index);
    record.set(0, encode(&updated)?).await
}

fn next_index(latest: Option<u64>) -> Result<u64> {
    match latest {
        None => Ok(0),
        Some(index) => index
            .checked_add(1)
            .ok_or_else(|| Error::new(409, "post index exhausted")),
    }
}

fn post_subkey(index: u64) -> u32 {
    1 + (index % CAPACITY) as u32
}

fn recent_indexes(latest: Option<u64>) -> Vec<u64> {
    match latest {
        None => vec![],
        Some(latest) => (latest.saturating_sub(FEED_LIMIT - 1)..=latest)
            .rev()
            .collect(),
    }
}

pub fn validate_content(content: &str) -> Result<()> {
    if content.trim().is_empty() || content.chars().count() > 280 {
        return Err(Error::new(
            400,
            "post must be nonblank and at most 280 characters",
        ));
    }
    Ok(())
}

struct VeilidRecord<'a> {
    context: &'a RoutingContext,
    key: RecordKey,
    writer: Option<KeyPair>,
}

impl RecordIo for VeilidRecord<'_> {
    async fn get(&self, subkey: u32) -> Result<Option<Vec<u8>>> {
        deadline(
            async {
                self.context
                    .get_dht_value(self.key.clone(), subkey, true)
                    .await
                    .map(|value| value.map(|value| value.data().to_vec()))
                    .map_err(Into::into)
            },
            30,
        )
        .await
    }

    async fn set(&self, subkey: u32, data: Vec<u8>) -> Result<()> {
        deadline(
            async {
                let result = self
                    .context
                    .set_dht_value(
                        self.key.clone(),
                        subkey,
                        data.clone(),
                        Some(SetDHTValueOptions {
                            writer: self.writer.clone(),
                            allow_offline: Some(AllowOffline(false)),
                            ..Default::default()
                        }),
                    )
                    .await?;
                if result.is_some_and(|value| value.data() != data.as_slice()) {
                    return Err(Error::new(
                        409,
                        "DHT write conflict; publication not confirmed",
                    ));
                }
                Ok(())
            },
            30,
        )
        .await
    }
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
                    .create_dht_record(CRYPTO_KIND_VLD0, DHTSchema::smpl(101, vec![])?, None)
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
        tracked(&self.workers, {
            let node = self.clone();
            async move { node.read_feed(key).await }
        })
        .await
    }

    async fn read_feed(&self, key: RecordKey) -> Result<Feed> {
        let _reader = self
            .readers
            .try_acquire()
            .map_err(|_| Error::new(503, "too many feed requests; retry later"))?;
        let _operation = deadline(async { Ok(self.operations.lock().await) }, 30).await?;
        self.check_ready()?;
        let remote = remote_key(&self.key(), &key)?;
        if remote {
            let opened = deadline(
                async {
                    self.context
                        .open_dht_record(key.clone(), None, None)
                        .await
                        .map_err(Into::into)
                },
                30,
            )
            .await;
            let descriptor = match opened {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    self.close_remote(key.clone()).await?;
                    return Err(error);
                }
            };
            if let Err(error) = validate_schema(descriptor.ref_schema()) {
                self.close_remote(key).await?;
                return Err(error);
            }
        }
        let record = VeilidRecord {
            context: &self.context,
            key: key.clone(),
            writer: None,
        };
        let result = deadline(
            async {
                let metadata = read_metadata(&record).await?;
                let posts = read_posts(&record, &metadata).await?;
                Ok(Feed {
                    record_key: key.to_string(),
                    metadata,
                    posts,
                })
            },
            60,
        )
        .await;
        if remote {
            self.close_remote(key).await?;
        }
        result
    }

    async fn close_remote(&self, key: RecordKey) -> Result<()> {
        match self.context.close_dht_record(key).await {
            Ok(()) | Err(VeilidAPIError::KeyNotFound { .. }) => Ok(()),
            Err(error) => Err(error.into()),
        }
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
    use std::{collections::BTreeMap, sync::Mutex};

    struct FakeRecord {
        values: Mutex<BTreeMap<u32, Vec<u8>>>,
        writes: Mutex<Vec<u32>>,
        fail_metadata: Mutex<bool>,
    }

    impl FakeRecord {
        fn new(metadata: &Metadata) -> Self {
            Self {
                values: Mutex::new(BTreeMap::from([(0, serde_json::to_vec(metadata).unwrap())])),
                writes: Mutex::new(vec![]),
                fail_metadata: Mutex::new(false),
            }
        }
    }

    impl RecordIo for FakeRecord {
        async fn get(&self, subkey: u32) -> Result<Option<Vec<u8>>> {
            Ok(self.values.lock().unwrap().get(&subkey).cloned())
        }

        async fn set(&self, subkey: u32, data: Vec<u8>) -> Result<()> {
            self.writes.lock().unwrap().push(subkey);
            if subkey == 0 && *self.fail_metadata.lock().unwrap() {
                return Err("metadata write failed".into());
            }
            self.values.lock().unwrap().insert(subkey, data);
            Ok(())
        }
    }

    fn metadata(latest: Option<u64>) -> Metadata {
        Metadata {
            author_name: "Test author".into(),
            bio: String::new(),
            latest_post_index: latest,
        }
    }

    fn post(index: u64) -> Post {
        Post {
            index,
            timestamp: 42,
            content: format!("post {index}"),
        }
    }

    #[test]
    fn empty_first_and_wrapped_feed() {
        assert!(recent_indexes(None).is_empty());
        assert_eq!(recent_indexes(Some(0)), vec![0]);
        assert_eq!(post_subkey(0), 1);
        assert_eq!(post_subkey(99), 100);
        assert_eq!(post_subkey(100), 1);
        assert_eq!(
            recent_indexes(Some(105)),
            (86..=105).rev().collect::<Vec<_>>()
        );
        assert_eq!(recent_indexes(Some(u64::MAX)).len(), 20);
    }

    #[test]
    fn validates_blank_and_unicode_post_limits() {
        assert!(validate_content(" \n\t").is_err());
        assert!(validate_content(&"猫".repeat(280)).is_ok());
        assert!(validate_content(&"猫".repeat(281)).is_err());
        assert!(validate_content("hello").is_ok());
    }

    #[test]
    fn rejects_incomplete_identity_and_incompatible_schema() {
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
        assert!(decode::<Metadata>(br#"{"author_name":"x","bio":""}"#).is_err());
        config.author_name = "Test".into();
        config.record_key = Some(
            "VLD0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                .parse()
                .unwrap(),
        );
        assert!(validate_config(&config).is_err());
        assert!(validate_schema(&DHTSchema::smpl(101, vec![]).unwrap()).is_ok());
        assert!(validate_schema(&DHTSchema::dflt(101).unwrap()).is_err());
        assert!(validate_schema(&DHTSchema::smpl(2, vec![]).unwrap()).is_err());
    }

    #[tokio::test]
    async fn publishes_post_before_metadata_and_recovers_same_post() {
        let initial = metadata(None);
        let record = FakeRecord::new(&initial);
        *record.fail_metadata.lock().unwrap() = true;
        assert!(commit_post(&record, &initial, &post(0)).await.is_err());
        let stored: Metadata =
            serde_json::from_slice(&record.get(0).await.unwrap().unwrap()).unwrap();
        assert_eq!(stored.latest_post_index, None);
        assert_eq!(*record.writes.lock().unwrap(), vec![1, 0]);
        *record.fail_metadata.lock().unwrap() = false;
        commit_post(&record, &stored, &post(0)).await.unwrap();
        let stored: Metadata =
            serde_json::from_slice(&record.get(0).await.unwrap().unwrap()).unwrap();
        assert_eq!(stored.latest_post_index, Some(0));
        let writes = record.writes.lock().unwrap().clone();
        commit_post(&record, &stored, &post(0)).await.unwrap();
        assert_eq!(*record.writes.lock().unwrap(), writes);
    }

    #[tokio::test]
    async fn refuses_conflicting_or_out_of_sequence_pending_post() {
        let initial = metadata(Some(99));
        let record = FakeRecord::new(&initial);
        record
            .set(1, serde_json::to_vec(&post(0)).unwrap())
            .await
            .unwrap();
        commit_post(&record, &initial, &post(100)).await.unwrap();
        assert!(read_posts(&record, &metadata(Some(100))).await.is_err());
        assert!(commit_post(&record, &metadata(Some(100)), &post(102))
            .await
            .is_err());
        let mut conflicting = post(100);
        conflicting.content = "different".into();
        assert!(commit_post(&record, &metadata(Some(100)), &conflicting)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reads_newest_posts_and_rejects_missing_corrupt_or_wrapped_slots() {
        let record = FakeRecord::new(&metadata(Some(105)));
        for index in 6..=105 {
            record
                .set(
                    post_subkey(index),
                    serde_json::to_vec(&post(index)).unwrap(),
                )
                .await
                .unwrap();
        }
        let posts = read_posts(&record, &metadata(Some(105))).await.unwrap();
        assert_eq!(posts.first().unwrap().index, 105);
        assert_eq!(posts.last().unwrap().index, 86);
        record
            .set(post_subkey(105), serde_json::to_vec(&post(5)).unwrap())
            .await
            .unwrap();
        assert!(read_posts(&record, &metadata(Some(105))).await.is_err());
        record
            .set(post_subkey(105), b"not json".to_vec())
            .await
            .unwrap();
        assert!(read_posts(&record, &metadata(Some(105))).await.is_err());
        record.values.lock().unwrap().remove(&post_subkey(105));
        assert!(read_posts(&record, &metadata(Some(105))).await.is_err());
        assert!(read_posts(&record, &metadata(None))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn completed_final_index_can_be_recovered_without_incrementing() {
        let latest = metadata(Some(u64::MAX));
        let record = FakeRecord::new(&latest);
        record
            .set(post_subkey(u64::MAX), encode(&post(u64::MAX)).unwrap())
            .await
            .unwrap();
        commit_post(&record, &latest, &post(u64::MAX))
            .await
            .unwrap();
        assert!(next_index(Some(u64::MAX)).is_err());
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

    #[test]
    fn rejects_owner_key_alias_without_reopening_owner() {
        let bare: RecordKey = "VLD0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            .parse()
            .unwrap();
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            .parse()
            .unwrap();
        let own = RecordKey::from_opaque(bare.opaque(), Some(secret));
        assert!(!remote_key(&own, &own).unwrap());
        assert!(remote_key(&own, &bare).is_err());
        let other: RecordKey = "VLD0:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
            .parse()
            .unwrap();
        assert!(remote_key(&own, &other).unwrap());
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
