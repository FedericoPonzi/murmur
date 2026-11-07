use murmur_core::vault::{open, seal, Error, MAX_CREDENTIALS, MAX_ENVELOPE};
use serde_json::Value;

const CREDENTIALS: &[u8] = br#"{"writer":"disposable-test-secret","pending_post":null}"#;
const PASSPHRASE: &str = "disposable passphrase \u{e9}";

#[test]
fn round_trip_preserves_bytes_and_uses_fresh_salt_and_nonce() {
    let first = seal(CREDENTIALS, PASSPHRASE).unwrap();
    let second = seal(CREDENTIALS, PASSPHRASE).unwrap();
    assert_eq!(open(&first, PASSPHRASE).unwrap().as_slice(), CREDENTIALS);
    assert_eq!(open(&second, PASSPHRASE).unwrap().as_slice(), CREDENTIALS);
    let first: Value = serde_json::from_slice(&first).unwrap();
    let second: Value = serde_json::from_slice(&second).unwrap();
    assert_ne!(first["header"]["salt"], second["header"]["salt"]);
    assert_ne!(first["header"]["nonce"], second["header"]["nonce"]);
}

#[test]
fn opens_the_portable_v1_reference_envelope() {
    // Generated independently with argon2-cffi and libsodium.
    assert_eq!(
        open(include_bytes!("vault-v1.json"), PASSPHRASE)
            .unwrap()
            .as_slice(),
        CREDENTIALS
    );
}

#[test]
fn wrong_password_and_tampering_never_return_plaintext() {
    let encoded = seal(CREDENTIALS, PASSPHRASE).unwrap();
    assert_eq!(
        open(&encoded, "different passphrase").unwrap_err(),
        Error::Authentication
    );
    assert_eq!(
        open(&encoded, PASSPHRASE.trim_end_matches('\u{e9}')).unwrap_err(),
        Error::Authentication
    );
    for field in ["ciphertext", "salt", "nonce"] {
        let mut modified: Value = serde_json::from_slice(&encoded).unwrap();
        let bytes = if field == "ciphertext" {
            &mut modified[field]
        } else {
            &mut modified["header"][field]
        };
        bytes[0] = Value::from(bytes[0].as_u64().unwrap() ^ 1);
        assert_eq!(
            open(&serde_json::to_vec(&modified).unwrap(), PASSPHRASE).unwrap_err(),
            Error::Authentication
        );
    }
}

#[test]
fn rejects_unknown_formats_and_untrusted_kdf_parameters() {
    let original: Value = serde_json::from_slice(&seal(CREDENTIALS, PASSPHRASE).unwrap()).unwrap();
    for (field, value) in [
        ("version", Value::from(2)),
        ("cipher", Value::from("none")),
        (
            "kdf",
            serde_json::json!({
                "algorithm": "argon2id", "version": 19,
                "memory_kib": 8, "iterations": 1, "parallelism": 1,
            }),
        ),
    ] {
        let mut modified = original.clone();
        modified["header"][field] = value;
        assert_eq!(
            open(&serde_json::to_vec(&modified).unwrap(), PASSPHRASE).unwrap_err(),
            Error::UnsupportedFormat
        );
    }
    let mut modified = original;
    modified["extra"] = Value::from(true);
    assert_eq!(
        open(&serde_json::to_vec(&modified).unwrap(), PASSPHRASE).unwrap_err(),
        Error::InvalidEnvelope
    );
}

#[test]
fn bounds_credentials_envelopes_and_passphrases() {
    assert_eq!(seal(&[], PASSPHRASE).unwrap_err(), Error::InvalidEnvelope);
    assert_eq!(
        seal(&vec![0; MAX_CREDENTIALS + 1], PASSPHRASE).unwrap_err(),
        Error::TooLarge
    );
    assert_eq!(
        open(&vec![0; MAX_ENVELOPE + 1], PASSPHRASE).unwrap_err(),
        Error::TooLarge
    );
    assert_eq!(seal(CREDENTIALS, "").unwrap_err(), Error::InvalidPassphrase);
    assert_eq!(
        seal(CREDENTIALS, &"\u{e9}".repeat(513)).unwrap_err(),
        Error::InvalidPassphrase
    );
    let encoded = seal(&vec![255; MAX_CREDENTIALS], &"\u{e9}".repeat(512)).unwrap();
    assert_eq!(
        open(&encoded, &"\u{e9}".repeat(512)).unwrap().len(),
        MAX_CREDENTIALS
    );
    for bytes in [b"not JSON".as_slice(), &encoded[..encoded.len() - 1]] {
        assert_eq!(open(bytes, PASSPHRASE).unwrap_err(), Error::InvalidEnvelope);
    }
}
