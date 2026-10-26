/** @jest-environment node */
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import { getDeploymentControlRepository } from "../../src/db";
import * as stripeClient from "../../src/services/stripeClient";
import { resolveRenewalAccess } from "../../src/services/renewalRecoveryAccess";
import { getRenewalRecoveryView } from "../../src/services/renewalRecoveryView";
import { renewalRecoveryFixture } from "../fixtures/renewalRecoveryService";
import { renewalSubscription } from "../fixtures/renewal";
import { paidEndsAt } from "../fixtures/renewalStripe";
import {
  seedServingRuntime,
  stopServingRuntime,
} from "../fixtures/servingRuntime";

const ownedSubscription = {
  ...renewalSubscription,
  stripeCustomerId: "cus_renewal",
};
const original = {
  mock: config.mock.enabled,
  enabled: config.stripe.renewalGraceEnabled,
  mode: config.subscription.stripeMode,
};
beforeEach(async () => {
  config.mock.enabled = true;
  config.stripe.renewalGraceEnabled = true;
  config.subscription.stripeMode = "test";
  resetMockStore();
  await seedServingRuntime();
  getMockStore().subscriptions.set(
    renewalSubscription.guildId,
    structuredClone(ownedSubscription),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  await stopServingRuntime();
  config.mock.enabled = original.mock;
  config.stripe.renewalGraceEnabled = original.enabled;
  config.subscription.stripeMode = original.mode;
});

test.each(["access", "view"] as const)(
  "actual %s caller refreshes under durable admission and refuses refresh during a hold",
  async (caller) => {
    const f = renewalRecoveryFixture();
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue(f.stripe);
    await f.track();
    f.fail();
    const repository = getRenewalRecoveryRepository();
    const before = await repository.getCurrent(renewalSubscription.guildId);
    const deployment = getDeploymentControlRepository();
    const control = await deployment.getRecord("ENV", "CONTROL");
    if (control?.recordType !== "control")
      throw new Error("Missing test control");
    getMockStore().deploymentControlRecords.set(
      JSON.stringify(["ENV", "CONTROL"]),
      {
        ...control,
        maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
      },
    );
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = () =>
      caller === "access"
        ? resolveRenewalAccess(ownedSubscription, paidEndsAt + 4000)
        : getRenewalRecoveryView({
            stripe: f.stripe,
            guildId: renewalSubscription.guildId,
            now: paidEndsAt + 4000,
          });
    expect(await invoke()).toMatchObject(
      caller === "access" ? { tier: null } : { status: "settlement_pending" },
    );
    expect(await repository.getCurrent(renewalSubscription.guildId)).toEqual(
      before,
    );
    expect(warning).toHaveBeenCalled();
    getMockStore().deploymentControlRecords.set(
      JSON.stringify(["ENV", "CONTROL"]),
      control,
    );
    expect(await invoke()).toMatchObject(
      caller === "access" ? { tier: "basic" } : { status: "grace" },
    );
    expect(
      await repository.getCurrent(renewalSubscription.guildId),
    ).toMatchObject({ state: "grace", enforcementAccepted: true });
  },
);
