import { Buffer } from "node:buffer";
import { manifestFixture } from "./productionIntroduction.js";
import { digest } from "../../../scripts/deployment/collector-payload.cjs";
import { manifestHash } from "../../../scripts/deployment/sandbox-manifest.cjs";
export function privateCaptureFixture() {
  const m = manifestFixture(),
    calls = [],
    objects = new Map();
  const binding = {
    kind: "versioned-private-s3-v1",
    storeId: m.evidenceStoreId,
    bucket: "private-synthetic",
    accountId: m.binding.accountId,
    region: m.binding.region,
    kmsKeyArn:
      "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111",
    policySha256: digest("{}"),
    lifecycleSha256: digest("null"),
    retentionUntil: 6000,
    administratorTrustSha256: "a".repeat(64),
  };
  const client = {
    config: { maxAttempts: async () => 1, region: async () => binding.region },
    send: async (command) => {
      calls.push(command);
      const key = command.constructor.name,
        i = command.input;
      const native = {
        GetBucketLocationCommand: { LocationConstraint: null },
        GetBucketVersioningCommand: { Status: "Enabled" },
        GetBucketOwnershipControlsCommand: {
          OwnershipControls: {
            Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
          },
        },
        GetPublicAccessBlockCommand: {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        },
        GetBucketPolicyStatusCommand: { PolicyStatus: { IsPublic: false } },
        GetBucketPolicyCommand: { Policy: "{}" },
        GetBucketEncryptionCommand: {
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  SSEAlgorithm: "aws:kms",
                  KMSMasterKeyID: binding.kmsKeyArn,
                },
                BucketKeyEnabled: false,
              },
            ],
          },
        },
      };
      if (key === "GetBucketLifecycleConfigurationCommand")
        throw Object.assign(new Error("absent"), {
          name: "NoSuchLifecycleConfiguration",
        });
      if (key === "PutObjectCommand") {
        objects.set(i.Key, Buffer.from(i.Body));
        return { VersionId: "v1" };
      }
      if (key === "GetObjectCommand")
        return {
          VersionId: "v1",
          ContentLength: objects.get(i.Key).length,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: binding.kmsKeyArn,
          BucketKeyEnabled: false,
          Body: [objects.get(i.Key)],
        };
      if (!native[key]) throw new Error(key);
      return native[key];
    },
  };
  return {
    m,
    binding,
    client,
    calls,
    objects,
    options: {
      m,
      manifestSha256: manifestHash(m),
      binding,
      client,
      now: () => 1000,
    },
  };
}
