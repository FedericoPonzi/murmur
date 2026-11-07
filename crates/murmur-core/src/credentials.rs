use crate::{decode, encode, vault, Error, Result};
use murmur_model::{validate_content, validate_profile, Metadata, Post};
use serde::{Deserialize, Serialize};
use veilid_core::{KeyPair, RecordKey, CRYPTO_KIND_VLD0};
use zeroize::Zeroizing;

pub const HISTORY_LIMIT: usize = 1000;

pub fn retain_post(history: &mut Vec<Post>, post: Post) -> Result<()> {
    validate_content(&post.content)?;
    if history.len() > HISTORY_LIMIT
        || history
            .windows(2)
            .any(|pair| pair[0].index >= pair[1].index)
    {
        return Err("Invalid authored history".into());
    }
    match history.binary_search_by_key(&post.index, |post| post.index) {
        Ok(index) if history[index] != post => return Err("Conflicting authored history".into()),
        Ok(_) => return Ok(()),
        Err(index) => history.insert(index, post),
    }
    if history.len() > HISTORY_LIMIT {
        history.drain(..history.len() - HISTORY_LIMIT);
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub version: u16,
    pub record_key: RecordKey,
    pub writer: KeyPair,
    pub profile: Metadata,
    #[serde(deserialize_with = "Option::deserialize")]
    pub pending: Option<Post>,
    pub history: Vec<Post>,
}

impl Credentials {
    pub fn validate_shape(&self) -> Result<()> {
        if self.version != 1 {
            return Err("Unsupported identity backup version".into());
        }
        if self.record_key.kind() != CRYPTO_KIND_VLD0
            || self.writer.kind() != CRYPTO_KIND_VLD0
            || self.record_key == RecordKey::from_opaque(self.record_key.opaque(), None)
        {
            return Err("Backup requires complete VLD0 feed credentials".into());
        }
        validate_profile(&self.profile.author_name, &self.profile.bio)?;
        if self.history.len() > HISTORY_LIMIT
            || self
                .history
                .windows(2)
                .any(|pair| pair[0].index >= pair[1].index)
            || self
                .history
                .last()
                .is_some_and(|post| Some(post.index) > self.profile.latest_post_index)
        {
            return Err("Invalid authored history in backup".into());
        }
        for post in self.history.iter().chain(self.pending.iter()) {
            validate_content(&post.content)?;
        }
        if self.pending.as_ref().is_some_and(|post| {
            self.profile
                .latest_post_index
                .is_some_and(|latest| post.index > latest.saturating_add(1))
        }) {
            return Err("Invalid pending publication in backup".into());
        }
        Ok(())
    }

    pub fn seal(&self, passphrase: &str) -> Result<Vec<u8>> {
        self.validate_shape()?;
        let plaintext = Zeroizing::new(encode(self)?);
        vault::seal(&plaintext, passphrase).map_err(Error::from)
    }

    pub fn open(envelope: &[u8], passphrase: &str) -> Result<Self> {
        let plaintext = vault::open(envelope, passphrase)?;
        let credentials: Self = decode(&plaintext)?;
        credentials.validate_shape()?;
        Ok(credentials)
    }
}
