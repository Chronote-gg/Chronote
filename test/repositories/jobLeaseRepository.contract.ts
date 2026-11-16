import type { JobLeaseRepository } from "../../src/repositories/jobLeaseRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";

export interface JobLeaseHarness {
  repository: JobLeaseRepository;
  dispose?(): Promise<void>;
}

const NOW = 1_000_000;
const CLOCK_SKEW_SECONDS = 15;
const lease = (owner: string, now = NOW) => ({
  name: "synthetic-job",
  owner,
  now,
  ttlSeconds: LIFECYCLE.renewalRecoveryLeaseSeconds,
});

export function jobLeaseContract(make: () => Promise<JobLeaseHarness>) {
  let h: JobLeaseHarness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.dispose?.();
  });

  it("the first owner acquires", async () => {
    await expect(
      h.repository.tryAcquireJobLease(lease("owner-a")),
    ).resolves.toBe(true);
  });
  it("a second owner is refused while the lease is live", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await expect(
      h.repository.tryAcquireJobLease(lease("owner-b", NOW + 1)),
    ).resolves.toBe(false);
  });
  it("the same owner renews", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await expect(
      h.repository.tryAcquireJobLease(lease("owner-a", NOW + 60)),
    ).resolves.toBe(true);
    await expect(
      h.repository.tryAcquireJobLease(
        lease("owner-b", NOW + LIFECYCLE.renewalRecoveryLeaseSeconds + 1),
      ),
    ).resolves.toBe(false);
  });
  it("a second owner acquires after expiry", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await expect(
      h.repository.tryAcquireJobLease(
        lease("owner-b", NOW + LIFECYCLE.renewalRecoveryLeaseSeconds + 1),
      ),
    ).resolves.toBe(true);
    await expect(
      h.repository.tryAcquireJobLease(
        lease("owner-a", NOW + LIFECYCLE.renewalRecoveryLeaseSeconds + 2),
      ),
    ).resolves.toBe(false);
  });
  it("a writer fifteen seconds ahead does not take a live lease", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await expect(
      h.repository.tryAcquireJobLease(
        lease("owner-b", NOW + CLOCK_SKEW_SECONDS),
      ),
    ).resolves.toBe(false);
  });
  it("the owner releases and another owner acquires at once", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await h.repository.releaseJobLease({
      name: "synthetic-job",
      owner: "owner-a",
    });
    await expect(
      h.repository.tryAcquireJobLease(lease("owner-b", NOW + 1)),
    ).resolves.toBe(true);
  });
  it("another owner's release leaves the lease", async () => {
    await h.repository.tryAcquireJobLease(lease("owner-a"));
    await expect(
      h.repository.releaseJobLease({ name: "synthetic-job", owner: "owner-b" }),
    ).resolves.toBeUndefined();
    await expect(
      h.repository.tryAcquireJobLease(lease("owner-b", NOW + 1)),
    ).resolves.toBe(false);
  });
  it("a release without a lease is a no-op", async () => {
    await expect(
      h.repository.releaseJobLease({ name: "synthetic-job", owner: "owner-a" }),
    ).resolves.toBeUndefined();
  });
}
