use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, TryRngCore};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(crate) fn random_url_token(byte_count: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_count];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn pkce_challenge(code_verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc_7636_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn tokens_preserve_random_bytes_and_url_safe_encoding() {
        let first = random_url_token(32).expect("OS entropy should be available");
        let second = random_url_token(32).expect("OS entropy should be available");
        assert_eq!(URL_SAFE_NO_PAD.decode(&first).unwrap().len(), 32);
        assert!(!first.contains('='));
        assert_ne!(first, second);
    }

    #[test]
    fn file_checksum_matches_sha256_vector() {
        let path =
            std::env::temp_dir().join(format!("chronote-sha256-test-{}", std::process::id()));
        fs::write(&path, b"abc").unwrap();
        let checksum = sha256_file(&path);
        fs::remove_file(&path).unwrap();
        assert_eq!(
            checksum.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(sha256_file(&path).is_err());
    }
}
