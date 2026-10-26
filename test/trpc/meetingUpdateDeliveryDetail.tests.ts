import {
  history as syntheticHistory,
  pending as pendingDelivery,
  now as updateNow,
  running as submittedDelivery,
} from "../types/meetingUpdateDelivery.fixture";
import { meetingUpdateDeliverySchema } from "../../src/types/meetingUpdateDelivery";
import { test } from "@jest/globals";
import type { MeetingHistory } from "../../src/types/db";
import { buildCaller } from "../utils/trpcCaller";
export function registerMeetingUpdateDeliveryDetailTests(
  setHistory: (row: MeetingHistory) => void,
) {
  test.each([
    "pending",
    "synced",
    "held",
    "blocked",
    "uncertain",
    "unpublished",
  ] as const)(
    "detail exposes only safe %s update delivery beside canonical content",
    async (status) => {
      const delivery = pendingDelivery();
      if (status === "synced") {
        delivery.parts.notesBody.acknowledged = 1;
        delivery.progress = { kind: "synced", syncedAt: updateNow };
        delivery.lastSuccess = { at: updateNow, contentRevision: 1 };
      }
      const submitted = submittedDelivery().progress;
      if (submitted.kind !== "running")
        throw new Error("Expected submitted fixture");
      const updateDelivery = meetingUpdateDeliverySchema.parse({
        ...delivery,
        ...(status === "held"
          ? { policy: { kind: "held", reason: "explicit_hold" } }
          : {}),
        ...(status === "unpublished"
          ? { policy: { kind: "unpublished" } }
          : {}),
        ...(status === "blocked"
          ? { progress: { kind: "blocked", reason: "missing_target" } }
          : {}),
        ...(status === "uncertain"
          ? {
              progress: {
                kind: "uncertain",
                reason: "provider_outcome_unknown",
                attempt: submitted.attempt,
                claim: submitted.claim,
                operations: submitted.operations,
              },
            }
          : {}),
      });
      const row = {
        ...syntheticHistory(),
        contentRevision: 1,
        canonicalWriter: {
          kind: "personal" as const,
          uploadId: "private-canonical-upload",
          instanceId: "private-canonical-owner",
          attempt: 1,
          claimId: "private-canonical-claim",
        },
        updateDelivery,
      };
      setHistory(row);
      const caller = buildCaller();
      const result = await caller.meetings.detail({
        serverId: row.guildId,
        meetingId: row.channelId_timestamp,
      });
      expect(result.meeting.notes).toBe("Original synthetic notes");
      expect(result.meeting).not.toHaveProperty("canonicalWriter");
      expect(JSON.stringify(result.meeting)).not.toMatch(
        /private-canonical-(owner|claim|upload)/,
      );
      expect(result.meeting.updateDelivery).toMatchObject({
        status,
        desiredRevision: 1,
        syncedRevision: status === "synced" ? 1 : null,
        pollable: status === "pending",
      });
      expect(Object.keys(result.meeting.updateDelivery).sort()).toEqual([
        "desiredRevision",
        "lastSuccess",
        "pollable",
        "reason",
        "status",
        "syncedRevision",
      ]);
      expect(JSON.stringify(result.meeting.updateDelivery)).not.toMatch(
        /operations|ownerInstanceId|lease|fingerprint|channelId|payload/,
      );
    },
  );
}
