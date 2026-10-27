/** @jest-environment node */
import {
  seedServingRuntime,
  stopServingRuntime,
} from "../fixtures/servingRuntime";
import * as stripeClient from "../../src/services/stripeClient";
import { resolveRenewalAccess } from "../../src/services/renewalRecoveryAccess";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import { renewalSubscription } from "../fixtures/renewal";
import { paidEndsAt } from "../fixtures/renewalStripe";
import { renewalRecoveryFixture } from "../fixtures/renewalRecoveryService";
const original = {
  mock: config.mock.enabled,
  mode: config.subscription.stripeMode,
  grace: config.stripe.renewalGraceEnabled,
};
beforeEach(async () => {
  config.mock.enabled = true;
  config.subscription.stripeMode = "test";
  resetMockStore();
  await seedServingRuntime();
  getMockStore().subscriptions.set(
    renewalSubscription.guildId,
    structuredClone(renewalSubscription),
  );
});
afterAll(stopServingRuntime);
afterEach(() => {
  config.mock.enabled = original.mock;
  config.subscription.stripeMode = original.mode;
  config.stripe.renewalGraceEnabled = original.grace;
});

test.each(["access", "refresh"])(
  "ends a canceled passive watch before its paid boundary through %s",
  async (path) => {
    const f = renewalRecoveryFixture();
    config.stripe.renewalGraceEnabled = false;
    await f.track();
    const before = await getRenewalRecoveryRepository().getCurrent(
      renewalSubscription.guildId,
    );
    const now = paidEndsAt - 100;
    f.subscription.status = "canceled";
    f.invoices.delete(f.renewal.id);
    const saved: typeof renewalSubscription = {
      ...renewalSubscription,
      stripeCustomerId: "cus_renewal",
      status: "canceled",
      tier: "free",
      endDate: new Date((now - 1) * 1000).toISOString(),
    };
    getMockStore().subscriptions.set(saved.guildId, saved);
    config.stripe.renewalGraceEnabled = true;
    const client = jest
      .spyOn(stripeClient, "getStripeClient")
      .mockReturnValue(f.stripe);
    try {
      if (path === "access")
        expect(await resolveRenewalAccess(saved, now)).toEqual({ tier: null });
      else expect(await f.refresh(now)).toMatchObject({ state: "ended" });
      expect(
        await getRenewalRecoveryRepository().getCurrent(saved.guildId),
      ).toMatchObject({
        state: "ended",
        paid: before?.paid,
        enforcementAccepted: false,
      });
      expect(f.requests.every((request) => request.method === "GET")).toBe(
        true,
      );
    } finally {
      client.mockRestore();
    }
  },
);
