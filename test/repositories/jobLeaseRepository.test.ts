/** @jest-environment node */
import {
  createMockJobLeaseRepository,
  getJobLeaseRepository,
} from "../../src/repositories/jobLeaseRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { useMockModeStore } from "./mockModeStore.fixture";
import { jobLeaseContract } from "./jobLeaseRepository.contract";

const lease = { name: "synthetic-job", now: 1_000_000, ttlSeconds: 600 };

describe("mock job lease", () => {
  jobLeaseContract(async () => ({
    repository: createMockJobLeaseRepository(new Map()),
  }));
});

describe("mock-mode binding", () => {
  useMockModeStore();

  it("shares one lease table per mock store", async () => {
    await getJobLeaseRepository().tryAcquireJobLease({ ...lease, owner: "a" });
    await expect(
      getJobLeaseRepository().tryAcquireJobLease({ ...lease, owner: "b" }),
    ).resolves.toBe(false);
    resetMockStore();
    await expect(
      getJobLeaseRepository().tryAcquireJobLease({ ...lease, owner: "b" }),
    ).resolves.toBe(true);
  });
});
