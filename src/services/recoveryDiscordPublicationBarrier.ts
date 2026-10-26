import { isDeepStrictEqual } from "node:util";
import type { MeetingHistory } from "../types/db";
import type { MeetingUpdateKey } from "../types/meetingUpdateDelivery";
import type { MeetingPublicationRepository } from "../repositories/meetingPublicationRepository";
import {
  publicationSnapshot,
  publicationSnapshotDigest,
} from "../types/meetingPublication";
import type {
  PublicationDependencies,
  RecoveryDiscordPreview,
} from "./recoveryDiscordPublicationTypes";
type Binding = Extract<RecoveryDiscordPreview, { kind: "ready" }>["binding"];
export function createRecoveryPublicationBarrier(input: {
  repository: MeetingPublicationRepository;
  key: MeetingUpdateKey;
  validate(history: MeetingHistory, binding: Binding): Promise<boolean>;
}): PublicationDependencies["publication"] {
  return {
    async acquire(request) {
      const row = await input.repository.getStrong(input.key);
      if (!row || row.meetingId !== request.binding.meetingId)
        throw new Error("Common publication history is missing or changed");
      const prior = row.publicationRepair;
      if (
        prior?.runId === request.runId &&
        prior.previewDigest === request.previewDigest &&
        prior.receiptKey === request.receiptKey
      )
        return prior;
      if (!request.reconcile && !(await input.validate(row, request.binding)))
        throw new Error(
          "Common publication snapshot differs from the approved preview",
        );
      const owner = {
        kind: "running" as const,
        runId: request.runId,
        previewDigest: request.previewDigest,
        receiptKey: request.receiptKey,
        snapshot: publicationSnapshotDigest(row),
      };
      if (
        (await input.repository.acquireRepair({
          key: input.key,
          expected: publicationSnapshot(row),
          owner,
        })) !== "owned"
      )
        throw new Error("Common publication row is occupied or changed");
      return owner;
    },
    async assertOwner(owner) {
      const row = await input.repository.getStrong(input.key);
      if (
        !row ||
        owner.kind !== "running" ||
        !isDeepStrictEqual(row.publicationRepair, owner) ||
        publicationSnapshotDigest(row) !== owner.snapshot
      )
        throw new Error(
          "Common publication owner or captured snapshot changed",
        );
    },
    async settle(request) {
      if (
        (await input.repository.settleRepair({
          ...request,
          key: input.key,
        })) !== "applied"
      )
        throw new Error("Common publication settlement was fenced");
    },
  };
}
