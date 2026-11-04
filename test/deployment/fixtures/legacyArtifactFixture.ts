import {
  legacyAttestedSnapshot,
  type LegacyArtifactWrite,
} from "../../../src/services/legacyArtifactAttestation";
import {
  artifactSafetyBaseSchema,
  artifactSafetyRecordSchema,
  type ArtifactSafetyRecord,
  type LegacyAttestation,
} from "../../../src/types/artifactSafety";
import { counts } from "./coordinatorFixture";
import { artifactSafetyFixture } from "./artifactSafetyFixture";

export const attestation: LegacyAttestation = {
  kind: "operator_attested_legacy",
  operator: "operator",
  reason: "first introduction",
  manifestUri: "s3://backup/recovery/inventory.json",
  manifestSha256: "b".repeat(64),
  capturedAt: 90,
  fileCount: 2,
  byteLength: 8,
  verifiedAt: 120,
  expiresAt: 3600,
};
export function legacyArtifactFixture() {
  const f = artifactSafetyFixture();
  const source = { ...f.source, workCounts: { ...counts(), finalization: 6 } };
  const attested = artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    revision: 0,
    heartbeatAt: 120,
    freshUntil: 180,
    startup: { kind: "pending" },
    state: "attested_legacy",
    attestation,
  });
  const requested = artifactSafetyRecordSchema.parse({
    ...attested,
    revision: 1,
    state: "requested",
    request: { ...f.expected.request, requestedAt: 120 },
  });
  const sealed = artifactSafetyRecordSchema.parse({
    ...requested,
    revision: 2,
    state: "sealed",
    proof: {
      snapshot: legacyAttestedSnapshot(attestation),
      provenAt: 120,
      expiresAt: 180,
    },
  });
  const write = (
    purpose: LegacyArtifactWrite["purpose"],
    expected: ArtifactSafetyRecord | undefined,
    next: ArtifactSafetyRecord,
  ): LegacyArtifactWrite => ({
    purpose,
    expected,
    next,
    runtime: source,
    control: f.ctl,
    now: 120,
  });
  return { ...f, source, attested, requested, sealed, write };
}
