import type { PersonalMediaUploadJobRecord } from "../../../src/types/db";

type LegacyDatabase = {
  tryAcquireActiveMeetingLease(lease: object, now: number): Promise<boolean>;
  writeMeetingHistory(history: object): Promise<void>;
  claimPersonalMediaUploadJob(
    input: object,
  ): Promise<PersonalMediaUploadJobRecord | undefined>;
  renewActiveMeetingLease(
    guildId: string,
    meetingId: string,
    instanceId: string,
    claimExpiresAt: number,
    updatedAt: string,
    expiresAt: number,
    patch: object,
  ): Promise<boolean>;
  renewPersonalMediaUploadJobClaim(input: object): Promise<boolean>;
  updateClaimedPersonalMediaUploadJobProgress(input: object): Promise<boolean>;
  writeClaimedPersonalMediaUploadJob(
    job: object,
    instanceId: string,
  ): Promise<boolean>;
  releaseActiveMeetingLease(
    guildId: string,
    meetingId: string,
    instanceId: string,
  ): Promise<boolean>;
};

const methods: (keyof LegacyDatabase)[] = [
  "tryAcquireActiveMeetingLease",
  "writeMeetingHistory",
  "claimPersonalMediaUploadJob",
  "renewActiveMeetingLease",
  "renewPersonalMediaUploadJobClaim",
  "updateClaimedPersonalMediaUploadJobProgress",
  "writeClaimedPersonalMediaUploadJob",
  "releaseActiveMeetingLease",
];

function isLegacyDatabase(value: unknown): value is LegacyDatabase {
  if (value === null || typeof value !== "object") return false;
  return methods.every(
    (method) => typeof Reflect.get(value, method) === "function",
  );
}

export function requireLegacyDatabase(value: unknown): LegacyDatabase {
  if (!isLegacyDatabase(value))
    throw new Error("Incomplete legacy database fixture exports");
  return value;
}
