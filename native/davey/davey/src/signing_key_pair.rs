use p256::{ecdsa::SigningKey, elliptic_curve::rand_core::OsRng};

/// A signing key pair. This is needed if you want to pass your own key pair or store the key pair for later.
#[derive(Clone, PartialEq, Eq)]
pub struct SigningKeyPair {
  pub private: Vec<u8>,
  pub public: Vec<u8>,
}

impl SigningKeyPair {
  /// Generate a signing key pair.
  pub fn generate() -> Self {
    let signing_key = SigningKey::random(&mut OsRng);

    SigningKeyPair {
      private: signing_key.to_bytes().to_vec(),
      public: signing_key
        .verifying_key()
        .to_encoded_point(false)
        .to_bytes()
        .to_vec(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use p256::ecdsa::{
    signature::{Signer, Verifier},
    Signature, VerifyingKey,
  };

  #[test]
  fn generated_key_bytes_round_trip_and_verify_signatures() {
    let pair = SigningKeyPair::generate();
    assert_eq!(pair.private.len(), 32);
    assert_eq!(pair.public.len(), 65);
    assert_eq!(pair.public[0], 4);
    let signing = SigningKey::from_slice(&pair.private).unwrap();
    let verifying = VerifyingKey::from_sec1_bytes(&pair.public).unwrap();
    assert_eq!(*signing.verifying_key(), verifying);
    let message = b"synthetic DAVE key compatibility";
    let signature: Signature = signing.sign(message);
    verifying.verify(message, &signature).unwrap();
  }

  #[test]
  fn generated_keys_are_fresh() {
    let first = SigningKeyPair::generate();
    let second = SigningKeyPair::generate();
    assert_ne!(first.private, second.private);
    assert_ne!(first.public, second.public);
  }
}
