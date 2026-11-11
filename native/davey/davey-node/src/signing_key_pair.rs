use napi::bindgen_prelude::Buffer;

/// A signing key pair.
#[napi(object)]
pub struct SigningKeyPair {
  /// The private key of this key pair.
  pub private: Buffer,
  /// The public key of this key pair.
  pub public: Buffer,
}

/// Create a P256 signing key pair.
#[napi]
pub fn generate_p256_keypair() -> napi::Result<SigningKeyPair> {
  let signing_key_pair = davey::SigningKeyPair::generate();

  Ok(SigningKeyPair {
    private: Buffer::from(signing_key_pair.private),
    public: Buffer::from(signing_key_pair.public),
  })
}
