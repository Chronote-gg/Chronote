import { randomUUID } from "node:crypto";
import { finalFixture } from "../fixtures/productionFinalAcceptance";
import {
  buildFinalAcceptanceTransaction,
  type FinalAcceptanceInput,
} from "../../src/services/productionAcceptanceTransactions";
import { completeItemSizeBound } from "../../src/services/productionAcceptanceConditions";
import { runtimeRecordSchema } from "../../src/types/deploymentControl";
import {
  createIntroductionTable,
  introductionClient as client,
  putIntroductionDocument as put,
  readIntroductionDocument as read,
  writeIntroduction as write,
} from "./fixtures/introductionStore";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createStripeWebhookDynamoRepository } from "../../src/repositories/stripeWebhookDynamoRepository";
import {
  createRuntimeLifecycle,
  installRuntimeLifecycle,
} from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import {
  continueStripeReceipt,
  receiptBirth,
} from "../../src/services/stripeWebhookReceiptService";
import {
  createServer,
  postWebhook,
  closeServer,
} from "../fixtures/billingWebhook";
import { stripeTransport } from "../fixtures/stripeTransport";
import { config } from "../../src/services/configService";
import type { StripeEvent } from "../../src/types/stripe";
const table = "acceptance-runtime-" + randomUUID(),
  events = "acceptance-receipt-" + randomUUID();
const repository = createDynamoDeploymentControlRepository(client, {
  deploymentControl: table,
  meetingHistory: "unused",
});
const receipts = createStripeWebhookDynamoRepository(client, events, {
  deploymentControl: table,
  meetingHistory: "unused",
});
jest.mock("../../src/repositories/stripeWebhookRepository", () => ({
  getStripeWebhookRepository: () => receipts,
}));
jest.mock("../../src/db", () => ({
  ...jest.requireActual("../../src/db"),
  getDeploymentControlRepository: () => repository,
}));
async function refreshGuard(input: FinalAcceptanceInput) {
  for (const g of input.guards) {
    const row = runtimeRecordSchema.parse(await read(table, g.key));
    g.row = row;
    g.maximumItemBytes = completeItemSizeBound(row);
  }
}
test("real lifecycle publication orders native reopening; lost finish ACK plus duplicate HTTP200 retains the owner", async () => {
  await createIntroductionTable(table);
  await createIntroductionTable(events, ["eventId"]);
  const persist = finalFixture("persist_acceptance", table);
  for (const row of [
    persist.hold,
    persist.control,
    persist.authority,
    persist.action,
    ...persist.guards.map((g) => g.row),
  ])
    await put(table, row);
  const identity = runtimeRecordSchema.parse(persist.guards[1].row).identity;
  if (identity.kind !== "ecs") throw Error("fixture must be ECS");
  const protection = createRuntimeProtectionService({
    identity,
    now: () => 320,
    agentUri: "http://127.0.0.1:1",
    onUnsafe: () => undefined,
    request: async () =>
      new Response(
        JSON.stringify({
          protection: {
            TaskArn: identity.taskArn,
            ProtectionEnabled: true,
            ExpirationDate: new Date(2000000).toISOString(),
          },
        }),
        { status: 200 },
      ),
  });
  const lifecycle = createRuntimeLifecycle({
    identity,
    repository,
    protection,
    now: () => 320,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: async () => undefined,
  });
  installRuntimeLifecycle(lifecycle);
  await protection.start();
  await lifecycle.refreshRuntimeReadiness();
  const handler = jest.fn(async () => undefined);
  try {
    await refreshGuard(persist);
    await write(buildFinalAcceptanceTransaction(persist));
    const reopen = finalFixture("reopen_admission", table);
    await put(table, reopen.action);
    await refreshGuard(reopen);
    const zero = buildFinalAcceptanceTransaction(reopen);
    const pending = lifecycle.beginRuntimeWork("pending_admission");
    await lifecycle.refreshRuntimeReadiness();
    expect(
      (await read(table, reopen.guards[1].key))?.workCounts.pending_admission,
    ).toBe(1);
    await expect(write(zero)).rejects.toThrow();
    expect(
      (await read(table, { pk: "ENV", sk: "CONTROL" }))?.maintenance,
    ).toBeDefined();
    pending.settle();
    await lifecycle.refreshRuntimeReadiness();
    const eventId = randomUUID(),
      unproven = randomUUID();
    const birth = await receiptBirth();
    expect(birth?.hold).toEqual(reopen.control.maintenance);
    await receipts.claim({
      eventId,
      receivedAt: "synthetic",
      state: "processing",
      leaseToken: "late",
      leaseUntil: Date.now() + 60000,
      birth,
      continuation: "not_admitted",
    });
    await receipts.claim({
      eventId: unproven,
      receivedAt: "synthetic",
      state: "processing",
      leaseToken: "unknown",
      leaseUntil: Date.now() + 60000,
    });
    await expect(
      continueStripeReceipt(eventId, "late", handler),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await lifecycle.refreshRuntimeReadiness();
    await refreshGuard(reopen);
    const actualReopen = buildFinalAcceptanceTransaction(reopen);
    // Another compatible raw row arrives after the guarded snapshot, before the actual atomic reopen.
    const later = randomUUID();
    await receipts.claim({
      eventId: later,
      receivedAt: "synthetic",
      state: "processing",
      leaseToken: "later",
      leaseUntil: Date.now() + 60000,
      birth,
      continuation: "not_admitted",
    });
    await write(actualReopen);
    await continueStripeReceipt(eventId, "late", handler);
    await continueStripeReceipt(later, "later", handler);
    expect(handler).toHaveBeenCalledTimes(2);
    await expect(
      continueStripeReceipt(unproven, "unknown", handler),
    ).rejects.toThrow("unproven");
    expect(handler).toHaveBeenCalledTimes(2);
    await lifecycle.refreshRuntimeReadiness();
    const release = finalFixture("release_deployment", table);
    await put(table, release.action);
    await refreshGuard(release);
    const zeroBeforeUnknown = buildFinalAcceptanceTransaction(release);
    const lost = randomUUID();
    await receipts.claim({
      eventId: lost,
      receivedAt: "synthetic",
      state: "processing",
      leaseToken: "finish",
      leaseUntil: Date.now() + 60000,
      birth: await receiptBirth(),
      continuation: "not_admitted",
    });
    const finish = receipts.finish.bind(receipts);
    const spy = jest
      .spyOn(receipts, "finish")
      .mockImplementationOnce(async (...args) => {
        await finish(...args);
        throw Error("finish ACK lost");
      });
    await expect(
      continueStripeReceipt(lost, "finish", handler),
    ).rejects.toThrow("finish ACK lost");
    spy.mockRestore();
    expect((await receipts.get(lost))?.state).toBe("completed");
    await lifecycle.refreshRuntimeReadiness();
    expect(Object.values(lifecycle.getWorkCounts()).some((n) => n > 0)).toBe(
      true,
    );
    await expect(write(zeroBeforeUnknown)).rejects.toThrow();
    const before = lifecycle.getWorkCounts();
    config.stripe.webhookSecret = "dummy-signature";
    const { stripe, requests } = stripeTransport(() => {
      throw Error("external transport forbidden");
    });
    const incoming = {
      id: lost,
      type: "checkout.session.expired",
      data: {
        object: {
          id: "synthetic",
          metadata: { guild_id: "guild", purchase_attempt_id: "purchase" },
        },
      },
    } as unknown as StripeEvent;
    jest.spyOn(stripe.webhooks, "constructEvent").mockReturnValue(incoming);
    const { server, baseUrl } = createServer(stripe);
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(200);
    } finally {
      await closeServer(server);
    }
    expect(requests).toHaveLength(0);
    expect(lifecycle.getWorkCounts()).toEqual(before);
    await put(table, {
      ...release.control,
      servingMembers: {},
      coordinatorExpiresAt: 500,
    });
    expect(
      (
        await lifecycle.prepareRuntimeRetirement({
          retirementEpoch: release.control.coordinatorEpoch,
        })
      ).kind,
    ).toBe("busy");
    expect(
      (await read(table, { pk: "ENV", sk: "INTRODUCTION" }))?.deployment.state,
    ).toBe("held");
  } finally {
    lifecycle.stop();
    jest.restoreAllMocks();
  }
});
