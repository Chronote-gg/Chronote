import { jest } from "@jest/globals";
import type { getMockStore } from "../../src/repositories/mockStore";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import { control, runtime } from "../deployment/controlFixtures";
export function featureCanonicalRecords(): Map<
  string,
  DeploymentControlRecord
> {
  const worker = {
    ...runtime("feature-runtime"),
    canonicalContentWriter: 1 as const,
  };
  const serving = {
    ...control,
    servingMembers: { "feature-runtime": worker.identity },
  };
  return new Map<string, DeploymentControlRecord>([
    [JSON.stringify(["ENV", "CONTROL"]), serving],
    [JSON.stringify(["ENV", "RUNTIME#feature-runtime"]), worker],
  ]);
}

export function createMockCanonicalUpdateService(
  store: ReturnType<typeof getMockStore>,
) {
  return createMeetingUpdateService({
    repository: createMockMeetingUpdateDeliveryRepository(
      store.meetingHistoryByGuild,
      () => true,
      store.personalMediaUploadsById,
      featureCanonicalRecords(),
    ),
    ready: async () => {},
    syncNotes: jest.fn(async () => {}),
  });
}
