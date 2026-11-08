pub mod credentials;
pub mod vault;

use murmur_model::{
    next_index, page_indexes, post_subkey, recent_indexes, validate_content, validate_profile,
    Feed, FeedPage, Metadata, ModelError, PageCursor, Post,
};
use serde::Serialize;
use std::future::Future;
use veilid_core::{
    AllowOffline, DHTSchema, KeyPair, RecordKey, RoutingContext, SetDHTValueOptions, VeilidAPIError,
};

#[derive(Debug)]
pub enum Error {
    NetworkTimeout,
    Unavailable,
    NotFound,
    Upstream,
    Model(ModelError),
    InvalidData(&'static str),
    Serialization,
    WriteConflict,
    IncompleteOwnerKey,
    Deadline,
    Vault(vault::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NetworkTimeout => "Veilid request timed out",
            Self::Unavailable => "Veilid network unavailable; retry later",
            Self::NotFound => "DHT record not found",
            Self::Upstream => "Veilid operation failed",
            Self::Model(error) => return error.fmt(f),
            Self::InvalidData(message) => message,
            Self::Serialization => "JSON serialization failed",
            Self::WriteConflict => "DHT write conflict; publication not confirmed",
            Self::IncompleteOwnerKey => "use the complete RecordKey, including its encryption key",
            Self::Deadline => "operation timed out; retry later",
            Self::Vault(error) => return error.fmt(f),
        })
    }
}

impl std::error::Error for Error {}

impl From<vault::Error> for Error {
    fn from(error: vault::Error) -> Self {
        Self::Vault(error)
    }
}

impl From<ModelError> for Error {
    fn from(error: ModelError) -> Self {
        Self::Model(error)
    }
}

impl From<VeilidAPIError> for Error {
    fn from(error: VeilidAPIError) -> Self {
        let error = match error {
            VeilidAPIError::Timeout => Self::NetworkTimeout,
            VeilidAPIError::TryAgain { .. } | VeilidAPIError::NoConnection { .. } => {
                Self::Unavailable
            }
            VeilidAPIError::KeyNotFound { .. } => Self::NotFound,
            _ => Self::Upstream,
        };
        // API arguments can contain writer credentials; log only the classification.
        veilid_core::tracing::warn!(%error);
        error
    }
}

impl From<&'static str> for Error {
    fn from(message: &'static str) -> Self {
        Self::InvalidData(message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub trait RecordIo {
    fn get(&self, subkey: u32) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;
    fn set(&self, subkey: u32, data: Vec<u8>) -> impl Future<Output = Result<()>> + Send;
}

pub fn validate_schema(schema: &DHTSchema) -> Result<()> {
    match schema {
        DHTSchema::SMPL(schema) => {
            murmur_model::validate_schema(schema.o_cnt(), schema.members().len())
                .map_err(Into::into)
        }
        _ => Err(ModelError::InvalidSchema.into()),
    }
}

pub fn remote_key(own: &RecordKey, requested: &RecordKey) -> Result<bool> {
    if own.opaque() != requested.opaque() {
        return Ok(true);
    }
    if own != requested {
        return Err(Error::IncompleteOwnerKey);
    }
    Ok(false)
}

pub fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| "invalid feed JSON".into())
}

pub fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| Error::Serialization)
}

pub async fn read_metadata(record: &impl RecordIo) -> Result<Metadata> {
    let bytes = record.get(0).await?.ok_or("feed metadata is missing")?;
    let metadata: Metadata = decode(&bytes)?;
    validate_profile(&metadata.author_name, &metadata.bio)
        .map_err(|_| Error::from("invalid feed profile"))?;
    Ok(metadata)
}

pub async fn read_posts(record: &impl RecordIo, metadata: &Metadata) -> Result<Vec<Post>> {
    read_indexes(record, recent_indexes(metadata.latest_post_index)).await
}

async fn read_indexes(record: &impl RecordIo, indexes: Vec<u64>) -> Result<Vec<Post>> {
    let mut posts = Vec::new();
    for index in indexes {
        let bytes = record
            .get(post_subkey(index))
            .await?
            .ok_or("feed is incomplete; retry later")?;
        let post: Post = decode(&bytes)?;
        if post.index != index {
            return Err("feed changed while reading; retry later".into());
        }
        validate_content(&post.content).map_err(|_| Error::from("invalid feed post"))?;
        posts.push(post);
    }
    Ok(posts)
}

pub async fn read_page(
    record: &impl RecordIo,
    record_key: String,
    cursor: Option<PageCursor>,
) -> Result<FeedPage> {
    let metadata = read_metadata(record).await?;
    let (indexes, next) = page_indexes(metadata.latest_post_index, cursor)?;
    let posts = read_indexes(record, indexes).await?;
    Ok(FeedPage {
        feed: Feed {
            record_key,
            metadata,
            posts,
        },
        next,
    })
}

pub async fn update_profile(
    record: &impl RecordIo,
    author_name: String,
    bio: String,
) -> Result<Metadata> {
    validate_profile(&author_name, &bio)?;
    let mut metadata = read_metadata(record).await?;
    metadata.author_name = author_name;
    metadata.bio = bio;
    record.set(0, encode(&metadata)?).await?;
    Ok(metadata)
}

pub async fn commit_post(record: &impl RecordIo, metadata: &Metadata, post: &Post) -> Result<()> {
    validate_content(&post.content)?;
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

pub async fn pending_confirmed(
    record: &impl RecordIo,
    metadata: &Metadata,
    post: &Post,
) -> Result<bool> {
    validate_content(&post.content)?;
    if metadata
        .latest_post_index
        .is_some_and(|latest| latest >= post.index)
    {
        let stored = record
            .get(post_subkey(post.index))
            .await?
            .map(|bytes| decode::<Post>(&bytes))
            .transpose()?;
        if stored.as_ref() != Some(post) {
            return Err(
                "Saved publication no longer matches its retained slot; manual recovery required"
                    .into(),
            );
        }
        return Ok(true);
    }
    if next_index(metadata.latest_post_index)? != post.index {
        return Err("Pending publication is out of sequence; manual recovery required".into());
    }
    Ok(false)
}

pub async fn deadline<T>(future: impl Future<Output = Result<T>>, seconds: u32) -> Result<T> {
    veilid_core::tools::timeout(seconds.saturating_mul(1000), future)
        .await
        .map_err(|_| Error::Deadline)?
}

pub struct VeilidRecord<'a> {
    pub context: &'a RoutingContext,
    pub key: RecordKey,
    pub writer: Option<KeyPair>,
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
                    return Err(Error::WriteConflict);
                }
                Ok(())
            },
            30,
        )
        .await
    }
}

pub async fn read_feed(
    context: &RoutingContext,
    own: Option<&RecordKey>,
    key: RecordKey,
) -> Result<Feed> {
    read_feed_page(context, own, key, None)
        .await
        .map(|page| page.feed)
}

pub async fn read_feed_page(
    context: &RoutingContext,
    own: Option<&RecordKey>,
    key: RecordKey,
    cursor: Option<PageCursor>,
) -> Result<FeedPage> {
    let remote = own
        .map(|own| remote_key(own, &key))
        .transpose()?
        .unwrap_or(true);
    if remote {
        let opened = deadline(
            async {
                context
                    .open_dht_record(key.clone(), None, None)
                    .await
                    .map_err(Into::into)
            },
            30,
        )
        .await;
        let checked = opened.and_then(|descriptor| validate_schema(descriptor.ref_schema()));
        if let Err(error) = checked {
            close_remote(context, key).await?;
            return Err(error);
        }
    }
    let record = VeilidRecord {
        context,
        key: key.clone(),
        writer: None,
    };
    let result = deadline(read_page(&record, key.to_string(), cursor), 60).await;
    if remote {
        close_remote(context, key).await?;
    }
    result
}

async fn close_remote(context: &RoutingContext, key: RecordKey) -> Result<()> {
    deadline(
        async {
            match context.close_dht_record(key).await {
                Ok(()) | Err(VeilidAPIError::KeyNotFound { .. }) => Ok(()),
                Err(error) => Err(error.into()),
            }
        },
        30,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use murmur_model::post_subkey;
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

    #[tokio::test]
    async fn profile_changes_preserve_feed_position_and_surface_write_failure() {
        let record = FakeRecord::new(&metadata(Some(105)));
        let updated = update_profile(&record, "New author".into(), "New bio".into())
            .await
            .unwrap();
        assert_eq!(updated.latest_post_index, Some(105));
        assert_eq!(read_metadata(&record).await.unwrap(), updated);
        assert_eq!(*record.writes.lock().unwrap(), vec![0]);
        assert!(update_profile(&record, " ".into(), "".into())
            .await
            .is_err());
        assert_eq!(*record.writes.lock().unwrap(), vec![0]);
        *record.fail_metadata.lock().unwrap() = true;
        assert!(update_profile(&record, "Other author".into(), "".into())
            .await
            .is_err());
        assert_eq!(read_metadata(&record).await.unwrap(), updated);
    }

    #[tokio::test]
    async fn pending_confirmation_checks_retained_values_without_writing() {
        let record = FakeRecord::new(&metadata(Some(3)));
        record
            .values
            .lock()
            .unwrap()
            .insert(post_subkey(2), encode(&post(2)).unwrap());
        assert!(pending_confirmed(&record, &metadata(Some(3)), &post(2))
            .await
            .unwrap());
        assert!(!pending_confirmed(&record, &metadata(Some(3)), &post(4))
            .await
            .unwrap());
        assert!(pending_confirmed(&record, &metadata(Some(3)), &post(1))
            .await
            .is_err());
        assert!(pending_confirmed(&record, &metadata(Some(3)), &post(5))
            .await
            .is_err());
        record
            .values
            .lock()
            .unwrap()
            .insert(post_subkey(2), encode(&post(102)).unwrap());
        assert!(pending_confirmed(&record, &metadata(Some(102)), &post(2))
            .await
            .is_err());
        assert!(record.writes.lock().unwrap().is_empty());
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
    async fn reads_all_retained_pages_and_fails_without_exposing_reused_slots() {
        let record = FakeRecord::new(&metadata(Some(105)));
        for index in 6..=105 {
            record
                .set(post_subkey(index), encode(&post(index)).unwrap())
                .await
                .unwrap();
        }
        let mut cursor = None;
        let mut indexes = vec![];
        loop {
            let page = read_page(&record, "feed-key".into(), cursor).await.unwrap();
            assert_eq!(page.feed.record_key, "feed-key");
            indexes.extend(page.feed.posts.iter().map(|post| post.index));
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(indexes, (6..=105).rev().collect::<Vec<_>>());
        let cursor = Some(murmur_model::PageCursor {
            anchor: 105,
            before: 86,
        });
        record.values.lock().unwrap().remove(&post_subkey(85));
        assert!(read_page(&record, "feed-key".into(), cursor).await.is_err());
        record
            .set(post_subkey(85), encode(&post(185)).unwrap())
            .await
            .unwrap();
        assert!(read_page(&record, "feed-key".into(), cursor).await.is_err());
        record
            .set(post_subkey(85), b"bad json".to_vec())
            .await
            .unwrap();
        assert!(read_page(&record, "feed-key".into(), cursor).await.is_err());
        record
            .set(0, encode(&metadata(Some(205))).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            read_page(&record, "feed-key".into(), cursor).await,
            Err(Error::Model(ModelError::CursorExpired))
        ));
        assert!(
            read_page(&FakeRecord::new(&metadata(None)), "empty".into(), None)
                .await
                .unwrap()
                .next
                .is_none()
        );
    }

    #[tokio::test]
    async fn completed_final_index_can_be_recovered_without_incrementing() {
        let latest = metadata(Some(u64::MAX));
        let record = FakeRecord::new(&latest);
        record
            .set(
                post_subkey(u64::MAX),
                serde_json::to_vec(&post(u64::MAX)).unwrap(),
            )
            .await
            .unwrap();
        commit_post(&record, &latest, &post(u64::MAX))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn refuses_invalid_pending_content_before_writing() {
        let record = FakeRecord::new(&metadata(None));
        let mut invalid = post(0);
        invalid.content = " ".into();
        assert!(matches!(
            commit_post(&record, &metadata(None), &invalid).await,
            Err(Error::Model(ModelError::InvalidContent))
        ));
        assert!(record.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_incompatible_schema() {
        assert!(validate_schema(&DHTSchema::smpl(101, vec![]).unwrap()).is_ok());
        assert!(validate_schema(&DHTSchema::dflt(101).unwrap()).is_err());
        assert!(validate_schema(&DHTSchema::smpl(2, vec![]).unwrap()).is_err());
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
    async fn deadlines_report_failure_instead_of_waiting_forever() {
        let result = deadline(std::future::pending::<Result<()>>(), 0).await;
        assert!(matches!(result, Err(Error::Deadline)));
    }
}
