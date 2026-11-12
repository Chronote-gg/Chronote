/** @jest-environment node */
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import * as stripeClient from "../../src/services/stripeClient";
import { resolveRenewalAccess } from "../../src/services/renewalRecoveryAccess";
import { getRenewalRecoveryView } from "../../src/services/renewalRecoveryView";
import { renewalRecoveryFixture } from "../fixtures/renewalRecoveryService";
import { renewalSubscription } from "../fixtures/renewal";
import { paidEndsAt } from "../fixtures/renewalStripe";

const ownedSubscription = {
  ...renewalSubscription,
  stripeCustomerId: "cus_renewal",
};
const original = {
  mock: config.mock.enabled,
  enabled: config.stripe.renewalGraceEnabled,
  mode: config.subscription.stripeMode,
};
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.renewalGraceEnabled = true;
  config.subscription.stripeMode = "test";
  resetMockStore();
  getMockStore().subscriptions.set(
    renewalSubscription.guildId,
    structuredClone(ownedSubscription),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  config.mock.enabled = original.mock;
  config.stripe.renewalGraceEnabled = original.enabled;
  config.subscription.stripeMode = original.mode;
});

test.each(["access", "view"] as const)(
  "actual %s caller refreshes the recovery without any deployment control record",
  async (caller) => {
    const f = renewalRecoveryFixture();
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue(f.stripe);
    await f.track();
    f.fail();
    const repository = getRenewalRecoveryRepository();
    const invoke = () =>
      caller === "access"
        ? resolveRenewalAccess(ownedSubscription, paidEndsAt + 4000)
        : getRenewalRecoveryView({
            stripe: f.stripe,
            guildId: renewalSubscription.guildId,
            now: paidEndsAt + 4000,
          });
    expect(getMockStore().deploymentControlRecords.size).toBe(0);
    expect(await invoke()).toMatchObject(
      caller === "access" ? { tier: "basic" } : { status: "grace" },
    );
    expect(
      await repository.getCurrent(renewalSubscription.guildId),
    ).toMatchObject({ state: "grace", enforcementAccepted: true });
  },
);
