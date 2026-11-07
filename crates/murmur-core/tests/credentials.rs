use murmur_core::credentials::{retain_post, Credentials, HISTORY_LIMIT};
use murmur_model::{Metadata, Post};

fn credentials() -> Credentials {
    let zero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    Credentials {
        version: 1,
        record_key: format!("VLD0:{zero}:{zero}").parse().unwrap(),
        writer: format!("VLD0:{zero}:{zero}").parse().unwrap(),
        profile: Metadata {
            author_name: "Author".into(),
            bio: "A public bio".into(),
            latest_post_index: Some(0),
        },
        pending: Some(Post {
            index: 1,
            timestamp: 2,
            content: "Pending text".into(),
        }),
        history: vec![Post {
            index: 0,
            timestamp: 1,
            content: "Confirmed text".into(),
        }],
    }
}

#[test]
fn encrypted_backup_preserves_identity_profile_and_publication_state() {
    let original = credentials();
    let envelope = original.seal("disposable backup passphrase").unwrap();
    let restored = Credentials::open(&envelope, "disposable backup passphrase").unwrap();
    assert_eq!(restored.record_key, original.record_key);
    assert_eq!(restored.writer, original.writer);
    assert_eq!(restored.profile, original.profile);
    assert_eq!(restored.pending, original.pending);
    assert_eq!(restored.history, original.history);
    let json: serde_json::Value = serde_json::from_slice(&envelope).unwrap();
    assert!(json.get("writer").is_none());
    assert!(Credentials::open(&envelope, "incorrect passphrase").is_err());
    let mut broken = envelope;
    broken[0] = b'!';
    assert!(Credentials::open(&broken, "disposable backup passphrase").is_err());
}

#[test]
fn refuses_incomplete_keys_invalid_profiles_and_inconsistent_history() {
    let mut value = credentials();
    value.record_key = "VLD0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        .parse()
        .unwrap();
    assert!(value.validate_shape().is_err());
    let mut value = credentials();
    value.version = 2;
    assert!(value.validate_shape().is_err());
    let mut value = credentials();
    value.profile.author_name = " ".into();
    assert!(value.validate_shape().is_err());
    let mut value = credentials();
    value.history.push(value.history[0].clone());
    assert!(value.validate_shape().is_err());
    let mut value = credentials();
    value.pending.as_mut().unwrap().content = " ".into();
    assert!(value.validate_shape().is_err());
    let mut value = credentials();
    value.history = vec![value.history[0].clone(); 1001];
    assert!(value.validate_shape().is_err());
}

#[test]
fn confirmed_history_is_bounded_deduplicated_and_refuses_conflicts() {
    let mut history: Vec<_> = (0..HISTORY_LIMIT as u64)
        .map(|index| Post {
            index,
            timestamp: index,
            content: format!("post {index}"),
        })
        .collect();
    let post = Post {
        index: HISTORY_LIMIT as u64,
        timestamp: 2,
        content: "Next post".into(),
    };
    retain_post(&mut history, post.clone()).unwrap();
    assert_eq!(history.len(), HISTORY_LIMIT);
    assert_eq!(history[0].index, 1);
    let saved = history.clone();
    retain_post(&mut history, post.clone()).unwrap();
    assert_eq!(history, saved);
    let mut conflict = post;
    conflict.content = "Different text".into();
    assert!(retain_post(&mut history, conflict).is_err());
    assert_eq!(history, saved);
}
