# Davey native source

MIT-licensed source from Snazzah/davey commit `a1e2e741bea06bc3b7167a5c3792844b8975993c`, corresponding to the Node package 0.1.12. The original LICENSE is retained; Cargo.lock tracks the reviewed local dependency updates. Only Rust source and build manifests needed by this workspace are included.

Local changes enforce protocol frame bounds and bounded ULEB128, and allow the existing decrypt API to parse transitional plaintext while unready through a temporary keyless decryptor. Tests cover native malformed-frame rejection and authenticated activation. No media keys or test credentials are vendored.

Signing-key generation uses the P-256 dependency's OS RNG re-export directly instead of a redundant direct `rand` dependency. This preserves the crypto trait version and the existing 32-byte private/65-byte uncompressed public key format. Tests verify key round trips, signing and independent generated keys.
