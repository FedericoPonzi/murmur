use argon2::{Algorithm, Argon2, Block, Params, Version};
use chacha20poly1305::{
    aead::{AeadInOut, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const MAX_CREDENTIALS: usize = 16 * 1024;
pub const MAX_ENVELOPE: usize = MAX_CREDENTIALS * 4 + 2048;
const MEMORY_KIB: u32 = 19_456;
const ITERATIONS: u32 = 2;
const PARALLELISM: u32 = 1;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidEnvelope,
    UnsupportedFormat,
    InvalidPassphrase,
    TooLarge,
    Authentication,
    Cryptography,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidEnvelope => "Invalid encrypted credential envelope",
            Self::UnsupportedFormat => "Unsupported credential format or encryption parameters",
            Self::InvalidPassphrase => "Passphrase must contain between 1 and 1024 UTF-8 bytes",
            Self::TooLarge => "Credential data is too large",
            Self::Authentication => "Wrong passphrase or damaged credential envelope",
            Self::Cryptography => "Credential encryption failed",
        })
    }
}

impl std::error::Error for Error {}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Kdf {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl Default for Kdf {
    fn default() -> Self {
        Self {
            algorithm: "argon2id".into(),
            version: 19,
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: PARALLELISM,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    cipher: String,
    kdf: Kdf,
    salt: [u8; 16],
    nonce: [u8; 24],
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    header: Header,
    ciphertext: Vec<u8>,
}

fn validate_passphrase(passphrase: &str) -> Result<(), Error> {
    if passphrase.is_empty() || passphrase.len() > 1024 {
        return Err(Error::InvalidPassphrase);
    }
    Ok(())
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, Error> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(32))
        .map_err(|_| Error::Cryptography)?;
    let mut key = Zeroizing::new([0u8; 32]);
    let mut memory = Zeroizing::new(Vec::new());
    memory
        .try_reserve_exact(params.block_count())
        .map_err(|_| Error::Cryptography)?;
    memory.resize(params.block_count(), Block::default());
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(passphrase.as_bytes(), salt, &mut *key, &mut memory)
        .map_err(|_| Error::Cryptography)?;
    Ok(key)
}

fn associated_data(header: &Header) -> Result<Vec<u8>, Error> {
    // Header field order is part of the v1 authenticated encoding.
    serde_json::to_vec(&("murmur/credentials", header)).map_err(|_| Error::InvalidEnvelope)
}

pub fn seal(credentials: &[u8], passphrase: &str) -> Result<Vec<u8>, Error> {
    validate_passphrase(passphrase)?;
    if credentials.len() > MAX_CREDENTIALS {
        return Err(Error::TooLarge);
    }
    if credentials.is_empty() {
        return Err(Error::InvalidEnvelope);
    }
    let mut header = Header {
        version: 1,
        cipher: "xchacha20poly1305".into(),
        kdf: Kdf::default(),
        salt: [0; 16],
        nonce: [0; 24],
    };
    getrandom::fill(&mut header.salt).map_err(|_| Error::Cryptography)?;
    getrandom::fill(&mut header.nonce).map_err(|_| Error::Cryptography)?;
    let key = derive_key(passphrase, &header.salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&*key).map_err(|_| Error::Cryptography)?;
    let mut body = Zeroizing::new(credentials.to_vec());
    cipher
        .encrypt_in_place(
            &XNonce::from(header.nonce),
            &associated_data(&header)?,
            &mut *body,
        )
        .map_err(|_| Error::Cryptography)?;
    serde_json::to_vec(&Envelope {
        header,
        ciphertext: body.to_vec(),
    })
    .map_err(|_| Error::InvalidEnvelope)
}

pub fn open(encoded: &[u8], passphrase: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
    validate_passphrase(passphrase)?;
    if encoded.len() > MAX_ENVELOPE {
        return Err(Error::TooLarge);
    }
    let envelope: Envelope = serde_json::from_slice(encoded).map_err(|_| Error::InvalidEnvelope)?;
    if envelope.header.version != 1
        || envelope.header.cipher != "xchacha20poly1305"
        || envelope.header.kdf != Kdf::default()
    {
        return Err(Error::UnsupportedFormat);
    }
    if envelope.ciphertext.len() > MAX_CREDENTIALS + 16 {
        return Err(Error::TooLarge);
    }
    if envelope.ciphertext.len() <= 16 {
        return Err(Error::InvalidEnvelope);
    }
    let key = derive_key(passphrase, &envelope.header.salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&*key).map_err(|_| Error::Cryptography)?;
    let mut body = Zeroizing::new(envelope.ciphertext);
    cipher
        .decrypt_in_place(
            &XNonce::from(envelope.header.nonce),
            &associated_data(&envelope.header)?,
            &mut *body,
        )
        .map_err(|_| Error::Authentication)?;
    Ok(body)
}
