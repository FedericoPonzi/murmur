#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use murmur_core::{RecordIo, VeilidRecord};
use murmur_model::{Metadata, Post, OWNER_SUBKEYS};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::Arc;
use veilid_core::{
    api_startup, DHTSchema, KeyPair, RecordKey, RoutingContext, TableDB, VeilidAPI, VeilidAPIError,
    VeilidConfig, VeilidConfigProtectedStoreBackend, CRYPTO_KIND_VLD0,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, JsValue>;

#[cfg(feature = "vault-tests")]
#[wasm_bindgen]
pub fn check_vault_format() -> Result<()> {
    use murmur_core::vault;
    let credentials = br#"{"writer":"disposable-test-secret","pending_post":null}"#;
    let passphrase = "disposable passphrase \u{e9}";
    let failure = |failure: vault::Error| error(&failure.to_string());
    let fixture = include_bytes!("../../murmur-core/tests/vault-v1.json");
    if vault::open(fixture, passphrase)
        .map_err(failure)?
        .as_slice()
        != credentials
    {
        return Err(error("Native/WASM credential format mismatch"));
    }
    let encoded = vault::seal(credentials, passphrase).map_err(failure)?;
    if vault::open(&encoded, passphrase)
        .map_err(failure)?
        .as_slice()
        != credentials
        || !matches!(
            vault::open(&encoded, "different passphrase"),
            Err(vault::Error::Authentication)
        )
    {
        return Err(error("WASM credential encryption check failed"));
    }
    Ok(())
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn now() -> f64;
}

#[derive(Serialize, Deserialize)]
struct TestIdentity {
    key: RecordKey,
    writer: KeyPair,
    #[serde(deserialize_with = "Option::deserialize")]
    post: Option<Post>,
    #[serde(default)]
    profile: Option<Metadata>,
}

fn error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

fn api_error(failure: VeilidAPIError) -> JsValue {
    core_error(failure.into())
}

fn core_error(failure: murmur_core::Error) -> JsValue {
    error(&failure.to_string())
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes)
        .map_err(|_| error("Invalid stored or network JSON; refusing to replace it"))
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| error("JSON serialization failed"))
}

#[wasm_bindgen]
pub struct BrowserNode {
    api: VeilidAPI,
    context: RoutingContext,
    table: TableDB,
    identity: Option<TestIdentity>,
    starts: u64,
    protected: bool,
}

#[wasm_bindgen]
pub async fn start_node(bootstrap: String) -> Result<BrowserNode> {
    start(bootstrap, None).await
}

#[wasm_bindgen]
pub async fn start_protected_node(bootstrap: String, passphrase: String) -> Result<BrowserNode> {
    start_protected(bootstrap, Zeroizing::new(passphrase)).await
}

async fn start_protected(bootstrap: String, passphrase: Zeroizing<String>) -> Result<BrowserNode> {
    murmur_core::vault::validate_passphrase(&passphrase)
        .map_err(|failure| error(&failure.to_string()))?;
    start(bootstrap, Some(passphrase)).await
}

#[wasm_bindgen]
pub async fn create_profile_node(
    bootstrap: String,
    passphrase: String,
    author_name: String,
    bio: String,
) -> Result<BrowserNode> {
    let passphrase = Zeroizing::new(passphrase);
    murmur_model::validate_profile(&author_name, &bio)
        .map_err(|failure| error(&failure.to_string()))?;
    start_identity(
        bootstrap,
        passphrase,
        Some(Metadata {
            author_name,
            bio,
            latest_post_index: None,
        }),
    )
    .await
}

#[wasm_bindgen]
pub async fn unlock_profile_node(bootstrap: String, passphrase: String) -> Result<BrowserNode> {
    start_identity(bootstrap, Zeroizing::new(passphrase), None).await
}

async fn start_identity(
    bootstrap: String,
    passphrase: Zeroizing<String>,
    profile: Option<Metadata>,
) -> Result<BrowserNode> {
    let mut node = start_protected(bootstrap, passphrase).await?;
    let result = if let Some(profile) = profile {
        if node.identity.is_some() {
            Err(error("An identity already exists. Unlock it instead."))
        } else {
            node.create_identity(Some(profile)).await
        }
    } else if node.identity.is_none() {
        Err(error(
            "No author identity found. Complete identity creation with the same passphrase.",
        ))
    } else {
        Ok(())
    };
    match result {
        Ok(()) => Ok(node),
        Err(failure) => {
            node.shutdown().await;
            Err(failure)
        }
    }
}

async fn start(bootstrap: String, passphrase: Option<Zeroizing<String>>) -> Result<BrowserNode> {
    let protected = passphrase.is_some();
    let namespace = if protected {
        "murmur-browser-identity"
    } else {
        "murmur-browser-probe"
    };
    let mut config = VeilidConfig::new(namespace, "murmur", "org", None, None);
    config.namespace = namespace.into();
    config.protected_store.backend = VeilidConfigProtectedStoreBackend::IndexedDb;
    if let Some(passphrase) = passphrase {
        config.protected_store.device_encryption_key_password = passphrase.to_string();
    }
    config.table_store.wipe_on_invalid_device_encryption_key = false;
    config.network.protocol.ws.connect = true;
    config.network.protocol.ws.listen = false;
    config.network.routing_table.bootstrap = vec![bootstrap];
    let api = api_startup(Arc::new(|_| {}), config)
        .await
        .map_err(api_error)?;
    let initialize = async {
        let context = api.routing_context().map_err(api_error)?;
        let table = api.open_table_db("probe", 1).await.map_err(api_error)?;
        let identity = table
            .load(0, b"identity".to_vec().into())
            .await
            .map_err(api_error)?
            .map(|bytes| decode::<TestIdentity>(&bytes))
            .transpose()?;
        if let Some(identity) = &identity {
            api.crypto()
                .map_err(api_error)?
                .check_keypair(&identity.writer)
                .map_err(api_error)?;
            if let Some(profile) = &identity.profile {
                murmur_model::validate_profile(&profile.author_name, &profile.bio)
                    .map_err(|failure| error(&failure.to_string()))?;
            }
        }
        let starts = table
            .load(0, b"starts".to_vec().into())
            .await
            .map_err(api_error)?
            .map(|bytes| decode::<u64>(&bytes))
            .transpose()?
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| error("Probe counter exhausted"))?;
        table
            .store(0, b"starts".to_vec().into(), encode(&starts)?.into())
            .await
            .map_err(api_error)?;
        api.attach().await.map_err(api_error)?;
        Ok((context, table, identity, starts))
    }
    .await;
    match initialize {
        Ok((context, table, identity, starts)) => Ok(BrowserNode {
            api,
            context,
            table,
            identity,
            starts,
            protected,
        }),
        Err(failure) => {
            api.shutdown().await;
            Err(failure)
        }
    }
}

#[wasm_bindgen]
impl BrowserNode {
    pub fn local_identity(&self) -> Result<String> {
        let public = self.identity.as_ref().map(|identity| {
            let profile = identity.profile.as_ref();
            serde_json::json!({
                "record_key": identity.key.to_string(),
                "author_name": profile.map_or("Murmur browser test", |profile| profile.author_name.as_str()),
                "bio": profile.map_or("", |profile| profile.bio.as_str()),
                "probe_post": identity.post,
            })
        });
        String::from_utf8(encode(&public)?).map_err(|_| error("JSON encoding failed"))
    }

    pub async fn status(&self) -> Result<String> {
        let state = self.api.get_state().await.map_err(api_error)?;
        String::from_utf8(encode(&serde_json::json!({
            "starts": self.starts,
            "ready": state.attachment.public_internet_ready,
            "protected": self.protected,
        }))?)
        .map_err(|_| error("JSON encoding failed"))
    }

    pub async fn identity_key(&mut self) -> Result<String> {
        self.require_ready().await?;
        if let Some(identity) = &self.identity {
            let descriptor = self
                .context
                .open_dht_record(identity.key.clone(), Some(identity.writer.clone()), None)
                .await
                .map_err(api_error)?;
            murmur_core::validate_schema(descriptor.ref_schema()).map_err(core_error)?;
            if descriptor.owner() != identity.writer.key() {
                return Err(error("Stored writer does not own the test record"));
            }
        } else if self.protected {
            return Err(error("Create an identity before publishing"));
        } else {
            self.create_identity(None).await?;
        }
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?;
        let record = VeilidRecord {
            context: &self.context,
            key: identity.key.clone(),
            writer: Some(identity.writer.clone()),
        };
        if record.get(0).await.map_err(core_error)?.is_none() {
            let initial = identity.profile.clone().unwrap_or_else(|| Metadata {
                author_name: "Murmur browser test".into(),
                bio: "".into(),
                latest_post_index: None,
            });
            record.set(0, encode(&initial)?).await.map_err(core_error)?;
        }
        Ok(self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?
            .key
            .to_string())
    }

    pub async fn reconcile_pending(&mut self) -> Result<String> {
        self.require_ready().await?;
        let identity = self.identity.as_ref().ok_or_else(|| error("No identity"))?;
        if let Some(post) = &identity.post {
            let record = VeilidRecord {
                context: &self.context,
                key: identity.key.clone(),
                writer: Some(identity.writer.clone()),
            };
            let metadata = murmur_core::read_metadata(&record)
                .await
                .map_err(core_error)?;
            if metadata.latest_post_index == Some(post.index) {
                murmur_core::commit_post(&record, &metadata, post)
                    .await
                    .map_err(core_error)?;
                self.clear_pending().await?;
            }
        }
        self.local_identity()
    }

    pub async fn publish_post(&mut self, content: String) -> Result<String> {
        murmur_model::validate_content(&content).map_err(|failure| error(&failure.to_string()))?;
        self.require_ready().await?;
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| error("Start an attached node first"))?;
        if identity
            .post
            .as_ref()
            .is_some_and(|post| post.content != content)
        {
            return Err(error(
                "A saved publication needs confirmation; retry its original text",
            ));
        }
        let record = VeilidRecord {
            context: &self.context,
            key: identity.key.clone(),
            writer: Some(identity.writer.clone()),
        };
        let metadata = murmur_core::read_metadata(&record)
            .await
            .map_err(core_error)?;
        let post = match &identity.post {
            Some(post) => post.clone(),
            None => Post {
                index: murmur_model::next_index(metadata.latest_post_index)
                    .map_err(|failure| error(&failure.to_string()))?,
                timestamp: (now() / 1000.0) as u64,
                content,
            },
        };
        self.identity
            .as_mut()
            .ok_or_else(|| error("No identity"))?
            .post = Some(post.clone());
        self.save_identity().await?;
        murmur_core::commit_post(&record, &metadata, &post)
            .await
            .map_err(core_error)?;
        self.clear_pending().await?;
        String::from_utf8(encode(&post)?).map_err(|_| error("JSON encoding failed"))
    }

    pub async fn read_feed(&self, key: String) -> Result<String> {
        let key: RecordKey = key.parse().map_err(|_| error("Invalid Veilid RecordKey"))?;
        let feed = murmur_core::read_feed(
            &self.context,
            self.identity.as_ref().map(|identity| &identity.key),
            key,
        )
        .await
        .map_err(core_error)?;
        String::from_utf8(encode(&feed)?).map_err(|_| error("JSON encoding failed"))
    }

    pub async fn shutdown(self) {
        self.api.shutdown().await;
    }

    #[cfg(feature = "vault-tests")]
    pub async fn test_seed_identity(&mut self) -> Result<String> {
        if !self.protected || self.identity.is_some() {
            return Err(error("Checks require a new protected identity"));
        }
        self.create_identity(None).await?;
        let identity = self
            .identity
            .as_mut()
            .ok_or_else(|| error("No test identity"))?;
        identity.post = Some(Post {
            index: 0,
            timestamp: 1,
            content: "disposable protected pending post".into(),
        });
        let key = identity.key.to_string();
        self.save_identity().await?;
        Ok(key)
    }

    #[cfg(feature = "vault-tests")]
    pub async fn test_storage(&self, snapshot: String) -> Result<String> {
        use data_encoding::BASE64URL_NOPAD;
        #[derive(Deserialize)]
        struct Row {
            key: Vec<u8>,
            value: Vec<u8>,
        }
        if !self.protected {
            return Err(error("Storage checks require a protected node"));
        }
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?;
        self.api
            .crypto()
            .map_err(api_error)?
            .check_keypair(&identity.writer)
            .map_err(api_error)?;
        let saved = self
            .table
            .load(0, b"identity".to_vec().into())
            .await
            .map_err(api_error)?
            .ok_or_else(|| error("Identity was not persisted"))?;
        let restored: TestIdentity = decode(&saved)?;
        if restored.key != identity.key
            || restored.writer != identity.writer
            || restored.post != identity.post
            || identity.post.as_ref().map(|post| post.content.as_str())
                != Some("disposable protected pending post")
        {
            return Err(error("Persisted writer or pending post mismatch"));
        }
        let secret = Zeroizing::new(identity.writer.secret().ref_value().to_string());
        let secret_bytes = Zeroizing::new(
            BASE64URL_NOPAD
                .decode(secret.as_bytes())
                .map_err(|_| error("Invalid signing secret encoding"))?,
        );
        let rows: Vec<Row> = decode(snapshot.as_bytes())?;
        let device_key = rows
            .iter()
            .find(|row| row.key == b"device_encryption_key")
            .ok_or_else(|| error("Device key was not persisted"))?;
        let encoded = std::str::from_utf8(&device_key.value)
            .map_err(|_| error("Invalid device key encoding"))?;
        let encrypted = BASE64URL_NOPAD
            .decode(
                encoded
                    .strip_suffix('!')
                    .ok_or_else(|| error("Invalid device key encoding"))?
                    .as_bytes(),
            )
            .map_err(|_| error("Invalid device key encoding"))?;
        if encrypted.len() != 76 || !encrypted.starts_with(b"VLD0") {
            return Err(error("Device key is not password protected"));
        }
        let forbidden = [
            secret.as_bytes(),
            secret_bytes.as_slice(),
            b"disposable protected storage passphrase",
            b"disposable protected pending post",
        ];
        for row in rows {
            for bytes in [&row.key, &row.value] {
                if forbidden
                    .iter()
                    .any(|needle| bytes.windows(needle.len()).any(|value| value == *needle))
                {
                    return Err(error(
                        "Plaintext credentials or pending post found in storage",
                    ));
                }
            }
        }
        Ok(identity.key.to_string())
    }
}

impl BrowserNode {
    async fn clear_pending(&mut self) -> Result<()> {
        let pending = self
            .identity
            .as_mut()
            .ok_or_else(|| error("No identity"))?
            .post
            .take();
        if let Err(failure) = self.save_identity().await {
            self.identity
                .as_mut()
                .ok_or_else(|| error("No identity"))?
                .post = pending;
            return Err(failure);
        }
        Ok(())
    }

    async fn require_ready(&self) -> Result<()> {
        if !self
            .api
            .get_state()
            .await
            .map_err(api_error)?
            .attachment
            .public_internet_ready
        {
            return Err(error("Veilid is not attached"));
        }
        Ok(())
    }

    async fn create_identity(&mut self, profile: Option<Metadata>) -> Result<()> {
        let descriptor = self
            .context
            .create_dht_record(
                CRYPTO_KIND_VLD0,
                DHTSchema::smpl(OWNER_SUBKEYS, vec![]).map_err(api_error)?,
                None,
            )
            .await
            .map_err(api_error)?;
        self.identity = Some(TestIdentity {
            key: descriptor.key(),
            writer: descriptor
                .owner_keypair()
                .ok_or_else(|| error("Created record has no writer"))?,
            post: None,
            profile,
        });
        self.save_identity().await
    }

    async fn save_identity(&self) -> Result<()> {
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?;
        self.table
            .store(0, b"identity".to_vec().into(), encode(identity)?.into())
            .await
            .map_err(api_error)
    }
}
