use serde::{Deserialize, Serialize};

pub const CAPACITY: u64 = 100;
pub const FEED_LIMIT: u64 = 20;
pub const OWNER_SUBKEYS: u16 = CAPACITY as u16 + 1;

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

#[derive(Serialize)]
pub struct Feed {
    pub record_key: String,
    pub metadata: Metadata,
    pub posts: Vec<Post>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PageCursor {
    pub anchor: u64,
    pub before: u64,
}

#[derive(Serialize)]
pub struct FeedPage {
    #[serde(flatten)]
    pub feed: Feed,
    pub next: Option<PageCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelError {
    InvalidContent,
    InvalidProfile,
    InvalidSchema,
    IndexExhausted,
    InvalidCursor,
    CursorExpired,
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidContent => "post must be nonblank and at most 280 characters",
            Self::InvalidProfile => {
                "profile needs a nonblank name (max 80 characters) and bio (max 280)"
            }
            Self::InvalidSchema => {
                "incompatible feed schema (expected 101 owner-only SMPL subkeys)"
            }
            Self::IndexExhausted => "post index exhausted",
            Self::InvalidCursor => "invalid feed page cursor",
            Self::CursorExpired => "retained feed window changed; refresh the feed",
        })
    }
}

impl std::error::Error for ModelError {}

pub fn post_subkey(index: u64) -> u32 {
    1 + (index % CAPACITY) as u32
}

pub fn recent_indexes(latest: Option<u64>) -> Vec<u64> {
    match latest {
        None => vec![],
        Some(latest) => (latest.saturating_sub(FEED_LIMIT - 1)..=latest)
            .rev()
            .collect(),
    }
}

pub fn page_indexes(
    latest: Option<u64>,
    cursor: Option<PageCursor>,
) -> Result<(Vec<u64>, Option<PageCursor>), ModelError> {
    let Some(latest) = latest else {
        return if cursor.is_some() {
            Err(ModelError::CursorExpired)
        } else {
            Ok((vec![], None))
        };
    };
    let anchor = cursor.map_or(latest, |cursor| cursor.anchor);
    let floor = anchor.saturating_sub(CAPACITY - 1);
    let top = if let Some(cursor) = cursor {
        if cursor.before == 0 || cursor.before > anchor || cursor.before <= floor {
            return Err(ModelError::InvalidCursor);
        }
        cursor.before - 1
    } else {
        latest
    };
    let bottom = top.saturating_sub(FEED_LIMIT - 1).max(floor);
    if anchor > latest || bottom < latest.saturating_sub(CAPACITY - 1) {
        return Err(ModelError::CursorExpired);
    }
    let next = (bottom > floor).then_some(PageCursor {
        anchor,
        before: bottom,
    });
    Ok(((bottom..=top).rev().collect(), next))
}

pub fn next_index(latest: Option<u64>) -> Result<u64, ModelError> {
    match latest {
        None => Ok(0),
        Some(index) => index.checked_add(1).ok_or(ModelError::IndexExhausted),
    }
}

pub fn validate_content(content: &str) -> Result<(), ModelError> {
    if content.trim().is_empty() || content.chars().count() > 280 {
        return Err(ModelError::InvalidContent);
    }
    Ok(())
}

pub fn validate_profile(author_name: &str, bio: &str) -> Result<(), ModelError> {
    if author_name.trim().is_empty()
        || author_name.chars().count() > 80
        || bio.chars().count() > 280
    {
        return Err(ModelError::InvalidProfile);
    }
    Ok(())
}

/// Validate counts from a SMPL schema; the transport must first check its kind.
pub fn validate_schema(owner_subkeys: u16, member_count: usize) -> Result<(), ModelError> {
    if owner_subkeys != OWNER_SUBKEYS || member_count != 0 {
        return Err(ModelError::InvalidSchema);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn paginates_only_the_anchored_retained_window() {
        assert_eq!(page_indexes(None, None).unwrap(), (vec![], None));
        for latest in [0, 19, 20, 99, 105, u64::MAX] {
            let mut cursor = None;
            let mut all = vec![];
            loop {
                let (indexes, next) = page_indexes(Some(latest), cursor).unwrap();
                assert!(indexes.len() <= FEED_LIMIT as usize);
                all.extend(indexes);
                cursor = next;
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(
                all,
                (latest.saturating_sub(CAPACITY - 1)..=latest)
                    .rev()
                    .collect::<Vec<_>>()
            );
        }
        let (_, cursor) = page_indexes(Some(105), None).unwrap();
        let (indexes, _) = page_indexes(Some(110), cursor).unwrap();
        assert_eq!(indexes, (66..=85).rev().collect::<Vec<_>>());
    }

    #[test]
    fn rejects_invalid_and_overwritten_page_cursors() {
        for before in [0, 6, 106] {
            assert_eq!(
                page_indexes(
                    Some(105),
                    Some(PageCursor {
                        anchor: 105,
                        before
                    })
                ),
                Err(ModelError::InvalidCursor)
            );
        }
        let cursor = Some(PageCursor {
            anchor: 105,
            before: 26,
        });
        assert_eq!(
            page_indexes(Some(110), cursor),
            Err(ModelError::CursorExpired)
        );
        assert_eq!(page_indexes(None, cursor), Err(ModelError::CursorExpired));
        assert_eq!(
            page_indexes(Some(104), cursor),
            Err(ModelError::CursorExpired)
        );
        assert!(
            serde_json::from_str::<PageCursor>(r#"{"anchor":105,"before":26,"extra":1}"#).is_err()
        );
    }

    #[test]
    fn next_index_distinguishes_empty_feed_and_checks_overflow() {
        assert_eq!(next_index(None).unwrap(), 0);
        assert_eq!(next_index(Some(0)).unwrap(), 1);
        assert_eq!(next_index(Some(u64::MAX)), Err(ModelError::IndexExhausted));
    }

    #[test]
    fn validates_blank_and_unicode_post_limits() {
        assert!(validate_content(" \n\t").is_err());
        assert!(validate_content(&"猫".repeat(280)).is_ok());
        assert!(validate_content(&"猫".repeat(281)).is_err());
        assert!(validate_content("hello").is_ok());
    }

    #[test]
    fn validates_profile_without_truncating_unicode() {
        assert!(validate_profile(" ", "").is_err());
        assert!(validate_profile(&"猫".repeat(80), &"猫".repeat(280)).is_ok());
        assert!(validate_profile(&"猫".repeat(81), "").is_err());
        assert!(validate_profile("Author", &"猫".repeat(281)).is_err());
    }

    #[test]
    fn rejects_incompatible_schema_counts_and_members() {
        assert!(validate_schema(101, 0).is_ok());
        assert!(validate_schema(100, 0).is_err());
        assert!(validate_schema(102, 0).is_err());
        assert!(validate_schema(101, 1).is_err());
    }

    #[test]
    fn preserves_feed_json_contract_and_requires_latest_index() {
        let mut metadata = Metadata {
            author_name: "Author".into(),
            bio: "".into(),
            latest_post_index: None,
        };
        let empty = json!({"author_name": "Author", "bio": "", "latest_post_index": null});
        assert_eq!(serde_json::to_value(&metadata).unwrap(), empty);
        assert_eq!(serde_json::from_value::<Metadata>(empty).unwrap(), metadata);
        assert!(
            serde_json::from_value::<Metadata>(json!({"author_name": "Author", "bio": ""}))
                .is_err()
        );
        metadata.latest_post_index = Some(0);
        let post = Post {
            index: 0,
            timestamp: 42,
            content: "hello".into(),
        };
        assert_eq!(
            serde_json::from_value::<Post>(
                json!({"index": 0, "timestamp": 42, "content": "hello"})
            )
            .unwrap(),
            post
        );
        let feed = Feed {
            record_key: "feed-key".into(),
            metadata,
            posts: vec![post],
        };
        assert_eq!(
            serde_json::to_value(feed).unwrap(),
            json!({
                "record_key": "feed-key",
                "metadata": {"author_name": "Author", "bio": "", "latest_post_index": 0},
                "posts": [{"index": 0, "timestamp": 42, "content": "hello"}]
            })
        );
    }
}
