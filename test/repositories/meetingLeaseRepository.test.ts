/** @jest-environment node */
import {
  createMockMeetingLeaseRepository,
  getMeetingLeaseRepository,
} from "../../src/repositories/meetingLeaseRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import {
  GUILD,
  leaseRecord,
  meetingLeaseRepositoryContract,
  suppressionRecord,
} from "./meetingLeaseRepository.contract";

describe("mock meeting lease repository", () => {
  meetingLeaseRepositoryContract(async () => {
    const leases = new Map<string, ActiveMeetingLease>();
    const histories = new Map<string, MeetingHistory[]>();
    const records = new Map<string, DeploymentControlRecord>();
    return {
      repository: createMockMeetingLeaseRepository(leases, histories, records),
      async seedLease(lease) {
        leases.set(lease.guildId, structuredClone(lease));
      },
      async seedHistory(row) {
        histories.set(row.guildId, [structuredClone(row)]);
      },
      async seedSuppression(row) {
        const record = suppressionRecord(row);
        records.set(JSON.stringify([record.pk, record.sk]), record);
      },
      async readHistory(key) {
        return histories
          .get(key.guildId)
          ?.find((row) => row.channelId_timestamp === key.channelId_timestamp);
      },
    };
  });
});

describe("mock-mode binding", () => {
  const enabled = config.mock.enabled;
  beforeEach(() => {
    config.mock.enabled = true;
    resetMockStore();
  });
  afterEach(() => {
    config.mock.enabled = enabled;
    resetMockStore();
  });

  it("uses the mock store's lease map", async () => {
    await getMeetingLeaseRepository().retake(leaseRecord(), 0);
    expect(getMockStore().activeMeetingLeases.get(GUILD)).toEqual(
      leaseRecord(),
    );
    resetMockStore();
    await expect(getMeetingLeaseRepository().read(GUILD)).resolves.toBe(
      undefined,
    );
  });
});
