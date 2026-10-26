/** @jest-environment node */
import { ECSClient } from "@aws-sdk/client-ecs";
import * as deploymentProof from "../../src/services/ledgerWriterDeployment";
import * as writerRuntime from "../../src/services/ledgerWriterRuntime";
import { trackPaidRenewalPeriod } from "../../src/services/renewalRecoveryService";
import {
  parseBillingRenewalRecoveryArgs,
  renewalCoverageExitCode,
} from "../../scripts/billing-renewal-recovery";
import { auditRenewalCoverage } from "../../src/services/renewalRecoveryCoverage";
import { config } from "../../src/services/configService";
import * as db from "../../src/db";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import { stripeTransport } from "../fixtures/stripeTransport";
import {
  sourceSubscription,
  fundedInvoice,
  paidEndsAt,
  paidStartsAt,
} from "../fixtures/renewalStripe";
import { renewalSubscription } from "../fixtures/renewal";
const original = {
  mock: config.mock.enabled,
  enabled: config.stripe.renewalGraceEnabled,
  mode: config.subscription.stripeMode,
};
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.renewalGraceEnabled = false;
  config.subscription.stripeMode = "test";
  resetMockStore();
});
afterEach(() => {
  config.mock.enabled = original.mock;
  config.stripe.renewalGraceEnabled = original.enabled;
  config.subscription.stripeMode = original.mode;
  jest.restoreAllMocks();
});
function fixture(paidHistory = true) {
  getMockStore().subscriptions.clear();
  getMockStore().subscriptions.set(renewalSubscription.guildId, {
    ...renewalSubscription,
    stripeCustomerId: "cus_renewal",
  });
  const native = {
    ...sourceSubscription,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      ...sourceSubscription.items,
      data: sourceSubscription.items.data.map((item) => ({ ...item })),
    },
  };
  const renewal = {
    ...fundedInvoice,
    id: "in_failed",
    status: "open" as const,
    billing_reason: "subscription_cycle" as const,
    amount_paid: 0,
    amount_remaining: 1000,
    status_transitions: {
      ...fundedInvoice.status_transitions,
      finalized_at: paidEndsAt + 3600,
    },
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        id: "il_failed",
        period: { start: paidEndsAt, end: paidEndsAt + 2592000 },
      })),
    },
  };
  const invoices = new Map([
    [fundedInvoice.id, { ...fundedInvoice }],
    [renewal.id, renewal],
  ]);
  const f = stripeTransport(({ path }) => {
    if (path === "/v1/account") return { id: "acct_owned" };
    if (path === "/v1/balance") return { livemode: false };
    if (path === `/v1/subscriptions/${native.id}`) return native;
    for (const invoice of invoices.values())
      if (path === `/v1/invoices/${invoice.id}`) return invoice;
    if (path === "/v1/invoices")
      return {
        object: "list",
        data: paidHistory ? [fundedInvoice] : [],
        has_more: false,
        url: path,
      };
    if (path === `/v1/prices/${native.items.data[0].price.id}`)
      return native.items.data[0].price;
    throw new Error(`Unexpected ${path}`);
  });
  return {
    ...f,
    invoices,
    native,
    renewal,
    input: {
      stripe: f.stripe,
      accountId: "acct_owned",
      mode: "test" as const,
      maxPages: 10,
      apply: false,
      now: paidStartsAt + 1,
    },
  };
}
test("requires explicit account, mode, private report and page bound; defaults to audit", () => {
  expect(
    parseBillingRenewalRecoveryArgs([
      "--account",
      "acct_owned",
      "--mode",
      "test",
      "--report",
      "private.json",
      "--max-pages",
      "2",
    ]),
  ).toMatchObject({ apply: false, maxPages: 2, mode: "test" });
  for (const args of [
    [],
    ["--account", "acct_owned"],
    ["--account", "acct_owned", "--mode", "test", "--report", "private.json"],
  ])
    expect(() => parseBillingRenewalRecoveryArgs(args)).toThrow();
});
test("audit never writes coverage or provider resources and cannot claim activation readiness", async () => {
  const f = fixture();
  const report = await auditRenewalCoverage(f.input);
  expect(report).toMatchObject({
    enumeration: "complete",
    coverageReady: false,
    phase: 2,
  });
  expect(report.outcomes).toEqual([
    expect.objectContaining({ state: "would_register" }),
  ]);
  expect(getMockStore().renewalRecoveryRecords.size).toBe(0);
  expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
});
test.each(["none", "zero", "paid_history"] as const)(
  "handles a trial with %s payment evidence without accepting a first-payment grace period",
  async (evidence) => {
    const f = fixture(evidence === "paid_history");
    f.native.status = "trialing";
    getMockStore().subscriptions.set(renewalSubscription.guildId, {
      ...renewalSubscription,
      stripeCustomerId: "cus_renewal",
      status: "trialing",
    });
    f.native.latest_invoice = evidence === "none" ? null : "in_trial";
    f.native.items.data[0].current_period_start = paidEndsAt;
    f.native.items.data[0].current_period_end = paidEndsAt + 2592000;
    f.invoices.set("in_trial", {
      ...fundedInvoice,
      id: "in_trial",
      total: 0,
      amount_paid: 0,
      amount_due: 0,
    });
    const report = await auditRenewalCoverage(f.input);
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        state: evidence === "paid_history" ? "would_register" : "ignored",
      }),
    ]);
    expect(report.enumeration).toBe("complete");
    expect(getMockStore().renewalRecoveryRecords.size).toBe(0);
    expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
  },
);

test("an applied coverage audit fails until index and deployed writer readiness are proved", async () => {
  const f = fixture();
  const report = await auditRenewalCoverage({ ...f.input, apply: true });
  expect(report.enumeration).toBe("complete");
  expect(report.outcomes.every((outcome) => outcome.state === "covered")).toBe(
    true,
  );
  expect(report.writerVerified).toBe(false);
  expect(renewalCoverageExitCode(report)).toBe(1);
  expect(renewalCoverageExitCode({ ...report, apply: false })).toBe(0);
  expect(
    renewalCoverageExitCode({
      ...report,
      writerVerified: true,
      indexActive: false,
    }),
  ).toBe(1);
  expect(
    renewalCoverageExitCode({
      ...report,
      writerVerified: true,
      indexActive: true,
      coverageReady: true,
    }),
  ).toBe(0);
});

test("apply is idempotent and writes only owned coverage", async () => {
  const f = fixture();
  const report = await auditRenewalCoverage({ ...f.input, apply: true });
  expect(report.outcomes).toEqual([
    expect.objectContaining({ state: "covered" }),
  ]);
  await auditRenewalCoverage({ ...f.input, apply: true });
  expect(getMockStore().renewalRecoveryRecords.size).toBe(1);
  expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
});
test("a capped traversal resumes but never presents the first pass as complete catch-up", async () => {
  const f = fixture();
  const first = await auditRenewalCoverage({
    ...f.input,
    apply: true,
    maxPages: 1,
  });
  expect(first).toMatchObject({
    enumeration: "incomplete",
    coverageReady: false,
    phase: 2,
  });
  const resumed = await auditRenewalCoverage({
    ...f.input,
    apply: true,
    resume: first,
  });
  expect(resumed.enumeration).toBe("complete");
});
test("the catch-up pass includes a paid row missed by the first traversal", async () => {
  const f = fixture();
  const scan = jest
    .spyOn(db, "scanGuildSubscriptionPage")
    .mockResolvedValueOnce({ guildIds: [] })
    .mockResolvedValueOnce({ guildIds: [renewalSubscription.guildId] });
  const result = await auditRenewalCoverage({ ...f.input, apply: true });
  expect(scan).toHaveBeenCalledTimes(2);
  expect(result.outcomes).toEqual([
    expect.objectContaining({
      guildId: renewalSubscription.guildId,
      state: "covered",
    }),
  ]);
});
test("failure on a final page preserves a resumable incomplete report", async () => {
  const f = fixture();
  jest
    .spyOn(db, "scanGuildSubscriptionPage")
    .mockResolvedValueOnce({
      guildIds: [renewalSubscription.guildId],
      cursor: "continuation",
    })
    .mockRejectedValueOnce(new Error("Scan unavailable"));
  const result = await auditRenewalCoverage({ ...f.input, apply: true });
  expect(result).toMatchObject({
    enumeration: "incomplete",
    coverageReady: false,
    cursor: "continuation",
  });
});
test("old unpaid debt keeps its original provider deadline while enforcement stays off", async () => {
  const f = fixture();
  f.native.status = "past_due";
  f.native.latest_invoice = f.renewal.id;
  f.native.items.data[0].current_period_start = paidEndsAt;
  f.native.items.data[0].current_period_end = paidEndsAt + 2592000;
  await auditRenewalCoverage({
    ...f.input,
    apply: true,
    now: paidEndsAt + 1000000,
  });
  expect(
    await getRenewalRecoveryRepository().getCurrent(
      renewalSubscription.guildId,
    ),
  ).toMatchObject({
    state: "grace",
    enforcementAccepted: false,
    endsAt: paidEndsAt + 3600 + 172800,
  });
  expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
});
test("provider identity mismatch and enabled enforcement prevent coverage writes", async () => {
  const f = fixture();
  await expect(
    auditRenewalCoverage({
      ...f.input,
      accountId: "acct_foreign",
      apply: true,
    }),
  ).rejects.toThrow();
  config.stripe.renewalGraceEnabled = true;
  await expect(
    auditRenewalCoverage({ ...f.input, apply: true }),
  ).rejects.toThrow();
  expect(getMockStore().renewalRecoveryRecords.size).toBe(0);
});

test("only complete catch-up, ACTIVE index and an exact normal-writer deployment witness establish readiness", async () => {
  const f = fixture();
  const runtime = {
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/current",
    imageDigest: "sha256:" + "a".repeat(64),
  };
  jest
    .spyOn(writerRuntime, "readLedgerWriterRuntime")
    .mockResolvedValue(runtime);
  await trackPaidRenewalPeriod({
    stripe: f.stripe,
    guildId: renewalSubscription.guildId,
    subscriptionId: f.native.id,
    invoiceId: fundedInvoice.id,
    now: f.input.now,
  });
  const target = {
    clusterArn: "cluster",
    serviceArn: "service",
    containerName: "api",
    imageDigest: runtime.imageDigest,
  };
  const verify = jest
    .spyOn(deploymentProof, "verifyLedgerWriterDeployment")
    .mockResolvedValue({
      ...target,
      taskDefinitionArn: "taskdef",
      taskArns: [runtime.taskArn],
    });
  const input = {
    ...f.input,
    apply: true,
    deployment: { ecs: new ECSClient({ region: "us-east-1" }), target },
  };
  const capped = await auditRenewalCoverage({ ...input, maxPages: 1 });
  expect(capped.coverageReady).toBe(false);
  const resumed = await auditRenewalCoverage({ ...input, resume: capped });
  expect(resumed.coverageReady).toBe(true);
  expect(verify).toHaveBeenCalledWith(input.deployment.ecs, target, runtime);
  jest.spyOn(db, "getRenewalRecoveryIndexStatus").mockResolvedValue("CREATING");
  expect((await auditRenewalCoverage(input)).coverageReady).toBe(false);
  verify.mockRejectedValueOnce(new Error("Deployed image changed"));
  expect(await auditRenewalCoverage(input)).toMatchObject({
    coverageReady: false,
    writerVerified: false,
  });
});
test("uses a current deployed writer even when an older same-image witness is encountered first", async () => {
  const { renewalRecoverySchema, renewalRecoveryKey } =
    await import("../../src/types/renewalRecovery");
  const f = fixture();
  const digest = "sha256:" + "a".repeat(64);
  const oldRuntime = {
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/retired",
    imageDigest: digest,
  };
  const currentRuntime = {
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/current",
    imageDigest: digest,
  };
  jest
    .spyOn(writerRuntime, "readLedgerWriterRuntime")
    .mockResolvedValue(oldRuntime);
  await trackPaidRenewalPeriod({
    stripe: f.stripe,
    guildId: renewalSubscription.guildId,
    subscriptionId: f.native.id,
    invoiceId: fundedInvoice.id,
    now: f.input.now,
  });
  const watch = await getRenewalRecoveryRepository().getCurrent(
    renewalSubscription.guildId,
  );
  if (!watch) throw new Error("Missing writer fixture");
  const first = renewalRecoverySchema.parse({
    ...watch,
    state: "grace",
    enforcementAccepted: true,
    invoice: {
      id: f.renewal.id,
      lineId: f.renewal.lines.data[0].id,
      finalizedAt: paidEndsAt + 3600,
      periodStart: paidEndsAt,
      periodEnd: paidEndsAt + 2592000,
    },
    endsAt: paidEndsAt + 3600 + 172800,
  });
  const second = renewalRecoverySchema.parse({
    ...first,
    guildId: "333333333333333333",
    subscriptionId: "sub_current_writer",
    customerId: "cus_current_writer",
    revision: "current-writer",
    writerRuntime: currentRuntime,
  });
  getMockStore().subscriptions.set(second.guildId, {
    ...renewalSubscription,
    guildId: second.guildId,
    stripeSubscriptionId: second.subscriptionId,
    stripeCustomerId: second.customerId,
  });
  for (const record of [first, second]) {
    getMockStore().renewalRecoveryRecords.set(
      renewalRecoveryKey(record),
      record,
    );
    getMockStore().renewalRecoveryPointers.set(record.guildId, {
      key: renewalRecoveryKey(record),
      revision: record.revision,
      blocking: true,
    });
  }
  const target = {
    clusterArn: "cluster",
    serviceArn: "service",
    containerName: "api",
    imageDigest: digest,
  };
  const verify = jest
    .spyOn(deploymentProof, "verifyLedgerWriterDeployment")
    .mockImplementation(async (_ecs, selected, witness) => {
      if (witness.taskArn === oldRuntime.taskArn)
        throw new Error("Retired task");
      return {
        ...selected,
        taskDefinitionArn: "taskdef",
        taskArns: [currentRuntime.taskArn],
      };
    });
  const result = await auditRenewalCoverage({
    ...f.input,
    apply: true,
    deployment: { ecs: new ECSClient({ region: "us-east-1" }), target },
  });
  expect(result).toMatchObject({
    coverageReady: true,
    writerVerified: true,
    writerSampleGuildId: second.guildId,
  });
  expect(verify).toHaveBeenCalledTimes(2);
});

test("resuming under another account or mode is rejected before scanning", async () => {
  const f = fixture();
  const resume = await auditRenewalCoverage({ ...f.input, maxPages: 1 });
  const scan = jest.spyOn(db, "scanGuildSubscriptionPage");
  await expect(
    auditRenewalCoverage({
      ...f.input,
      resume: { ...resume, accountId: "acct_foreign" },
    }),
  ).rejects.toThrow();
  expect(scan).not.toHaveBeenCalled();
});
