#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use murmur_model::{post_subkey, recent_indexes, Feed, Metadata, Post, OWNER_SUBKEYS};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::Arc;
use veilid_core::{
    api_startup, AllowOffline, DHTSchema, KeyPair, RecordKey, RoutingContext, SetDHTValueOptions,
    TableDB, VeilidAPI, VeilidAPIError, VeilidConfig, VeilidConfigProtectedStoreBackend,
    CRYPTO_KIND_VLD0,
};
use wasm_bindgen::prelude::*;

type Result<T> = std::result::Result<T, JsValue>;

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
    error(match failure {
        VeilidAPIError::Timeout => "Veilid request timed out; retry later",
        VeilidAPIError::TryAgain { .. } | VeilidAPIError::NoConnection { .. } => {
            "Veilid network unavailable; retry later"
        }
        VeilidAPIError::KeyNotFound { .. } => "DHT record not found",
        _ => "Veilid operation failed",
    })
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes)
        .map_err(|_| error("Invalid stored or network JSON; refusing to replace it"))
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| error("JSON serialization failed"))
}

fn validate_schema(schema: &DHTSchema) -> Result<()> {
    match schema {
        DHTSchema::SMPL(schema) => {
            murmur_model::validate_schema(schema.o_cnt(), schema.members().len())
                .map_err(|failure| error(&failure.to_string()))
        }
        _ => Err(error("Incompatible feed schema")),
    }
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
            validate_schema(descriptor.ref_schema())?;
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
        if self
            .context
            .get_dht_value(identity.key.clone(), 0, true)
            .await
            .map_err(api_error)?
            .is_none()
        {
            let initial = Metadata {
                author_name: "Murmur browser test".into(),
                bio: "".into(),
                latest_post_index: None,
            };
            let bytes = encode(&initial)?;
            if let Some(existing) = self
                .context
                .set_dht_value(
                    identity.key.clone(),
                    0,
                    bytes.clone(),
                    Some(SetDHTValueOptions {
                        allow_offline: Some(AllowOffline(false)),
                        ..Default::default()
                    }),
                )
                .await
                .map_err(api_error)?
            {
                if existing.data() != bytes {
                    return Err(error("Conflicting test metadata"));
                }
            }
        }
        Ok(self
            .identity
            .as_ref()
            .ok_or_else(|| error("No test identity"))?
            .key
            .to_string())
    }

    // The probe persists one immutable test post, not a second publication engine.
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
        let metadata = Metadata {
            author_name: "Murmur browser test".into(),
            bio: "".into(),
            latest_post_index: Some(0),
        };
        for (subkey, bytes) in [(1, encode(post)?), (0, encode(&metadata)?)] {
            if let Some(existing) = self
                .context
                .get_dht_value(identity.key.clone(), subkey, true)
                .await
                .map_err(api_error)?
            {
                let initial_metadata = if subkey == 0 {
                    let stored: Metadata = decode(existing.data())?;
                    stored
                        == Metadata {
                            latest_post_index: None,
                            ..metadata.clone()
                        }
                } else {
                    false
                };
                if existing.data() != bytes && !initial_metadata {
                    return Err(error("Conflicting test record; refusing to overwrite it"));
                }
            }
            let options = SetDHTValueOptions {
                allow_offline: Some(AllowOffline(false)),
                ..Default::default()
            };
            if let Some(existing) = self
                .context
                .set_dht_value(identity.key.clone(), subkey, bytes.clone(), Some(options))
                .await
                .map_err(api_error)?
            {
                if existing.data() != bytes {
                    return Err(error("Unconfirmed test publication; retry the same text"));
                }
            }
        }
        self.read_feed(identity.key.to_string()).await
    }

    pub async fn read_feed(&self, key: String) -> Result<String> {
        let key: RecordKey = key.parse().map_err(|_| error("Invalid Veilid RecordKey"))?;
        let remote = if let Some(identity) = &self.identity {
            if key.opaque() == identity.key.opaque() && key != identity.key {
                return Err(error(
                    "Use the complete test RecordKey, including its encryption key",
                ));
            }
            key.opaque() != identity.key.opaque()
        } else {
            true
        };
        if remote {
            let descriptor = self
                .context
                .open_dht_record(key.clone(), None, None)
                .await
                .map_err(api_error)?;
            let result = async {
                validate_schema(descriptor.ref_schema())?;
                self.read_open_feed(&key).await
            }
            .await;
            let closed = self.context.close_dht_record(key).await.map_err(api_error);
            let feed = result?;
            closed?;
            Ok(feed)
        } else {
            self.read_open_feed(&key).await
        }
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

    async fn read_open_feed(&self, key: &RecordKey) -> Result<String> {
        let value = self
            .context
            .get_dht_value(key.clone(), 0, true)
            .await
            .map_err(api_error)?
            .ok_or_else(|| error("Feed metadata is missing; publish the test post first"))?;
        let metadata: Metadata = decode(value.data())?;
        murmur_model::validate_profile(&metadata.author_name, &metadata.bio)
            .map_err(|_| error("Invalid feed profile"))?;
        let mut posts = Vec::new();
        for index in recent_indexes(metadata.latest_post_index) {
            let value = self
                .context
                .get_dht_value(key.clone(), post_subkey(index), true)
                .await
                .map_err(api_error)?
                .ok_or_else(|| error("Feed is incomplete; retry later"))?;
            let post: Post = decode(value.data())?;
            if post.index != index {
                return Err(error("Feed changed while reading; retry later"));
            }
            murmur_model::validate_content(&post.content)
                .map_err(|_| error("Invalid feed post"))?;
            posts.push(post);
        }
        String::from_utf8(encode(&Feed {
            record_key: key.to_string(),
            metadata,
            posts,
        })?)
        .map_err(|_| error("JSON encoding failed"))
    }
}
