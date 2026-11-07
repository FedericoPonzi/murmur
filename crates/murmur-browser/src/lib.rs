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
}

#[wasm_bindgen]
pub async fn start_node(bootstrap: String) -> Result<BrowserNode> {
    let mut config = VeilidConfig::new("murmur-browser-probe", "murmur", "org", None, None);
    config.namespace = "murmur-browser-probe".into();
    config.protected_store.backend = VeilidConfigProtectedStoreBackend::IndexedDb;
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
        }),
        Err(failure) => {
            api.shutdown().await;
            Err(failure)
        }
    }
}

#[wasm_bindgen]
impl BrowserNode {
    pub async fn status(&self) -> Result<String> {
        let state = self.api.get_state().await.map_err(api_error)?;
        String::from_utf8(encode(&serde_json::json!({
            "starts": self.starts,
            "ready": state.attachment.public_internet_ready,
        }))?)
        .map_err(|_| error("JSON encoding failed"))
    }

    pub async fn identity_key(&mut self) -> Result<String> {
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
        } else {
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
            });
            self.save_identity().await?;
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
            let initial = Metadata {
                author_name: "Murmur browser test".into(),
                bio: "".into(),
                latest_post_index: None,
            };
            record.set(0, encode(&initial)?).await.map_err(core_error)?;
        }
        Ok(self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?
            .key
            .to_string())
    }

    pub async fn publish_probe(&mut self, content: String) -> Result<String> {
        murmur_model::validate_content(&content).map_err(|failure| error(&failure.to_string()))?;
        let identity = self
            .identity
            .as_mut()
            .ok_or_else(|| error("Start an attached node first"))?;
        if let Some(post) = &identity.post {
            if post.content != content {
                return Err(error(
                    "This probe publishes only one post; retry with the same text",
                ));
            }
        } else {
            identity.post = Some(Post {
                index: 0,
                timestamp: (now() / 1000.0) as u64,
                content,
            });
        }
        self.save_identity().await?;
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?;
        let post = identity
            .post
            .as_ref()
            .ok_or_else(|| error("No test post"))?;
        let record = VeilidRecord {
            context: &self.context,
            key: identity.key.clone(),
            writer: Some(identity.writer.clone()),
        };
        let metadata = murmur_core::read_metadata(&record)
            .await
            .map_err(core_error)?;
        murmur_core::commit_post(&record, &metadata, post)
            .await
            .map_err(core_error)?;
        self.read_feed(identity.key.to_string()).await
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
}

impl BrowserNode {
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
