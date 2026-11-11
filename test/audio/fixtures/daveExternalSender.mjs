import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

// Test-only initial-epoch external Add signer. RFC 9420 sections 5.1.2, 6 and 12.1.8.
// Native MLS still creates/validates key packages, commits, welcomes and media keys.
function vector(bytes) {
  assert(
    bytes.length < 16384,
    "fixture only supports one/two-byte MLS lengths",
  );
  const prefix = Buffer.alloc(bytes.length < 64 ? 1 : 2);
  if (prefix.length === 1) prefix[0] = bytes.length;
  else prefix.writeUInt16BE(bytes.length | 0x4000);
  return Buffer.concat([prefix, bytes]);
}

export function createExternalSender(channelId) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const publicPoint = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const groupId = Buffer.alloc(8);
  groupId.writeBigUInt64BE(BigInt(channelId));
  return {
    package: Buffer.concat([
      vector(publicPoint),
      Buffer.from([0, 1]), // BasicCredential.
      vector(Buffer.from([0])),
    ]),
    add(keyPackage) {
      const tbs = Buffer.concat([
        Buffer.from([0, 1, 0, 1]), // MLS 1.0, PublicMessage.
        vector(groupId),
        Buffer.alloc(8), // Initial pending group epoch zero.
        Buffer.from([2, 0, 0, 0, 0]), // External sender index zero.
        Buffer.from([0, 2, 0, 1]), // Empty authenticated data, proposal, Add.
        keyPackage,
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([
          vector(Buffer.from("MLS 1.0 FramedContentTBS")),
          vector(tbs),
        ]),
        privateKey,
      );
      // External proposals carry a signature, without a membership tag.
      return vector(Buffer.concat([tbs, vector(signature)]));
    },
  };
}
