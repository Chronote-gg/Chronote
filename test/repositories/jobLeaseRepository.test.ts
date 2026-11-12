/** @jest-environment node */
import {
  createMockJobLeaseRepository,
  getJobLeaseRepository,
} from "../../src/repositories/jobLeaseRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import { jobLeaseContract } from "./jobLeaseRepository.contract";

const lease = { name: "synthetic-job", now: 1_000_000, ttlSeconds: 600 };

describe("mock job lease", () => {
  jobLeaseContract(async () => ({
    repository: createMockJobLeaseRepository(new Map()),
  }));
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
