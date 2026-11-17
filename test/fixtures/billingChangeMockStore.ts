import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import { changeOperation, changePointer } from "./billingChange";

/**
 * Runs each test in mock mode with subscription transitions off, against a
 * fresh mock store that holds the change's subscription pointer.
 */
export function useBillingChangeMockStore() {
  const previous = {
    mock: config.mock.enabled,
    transitions: config.stripe.subscriptionTransitionsEnabled,
  };
  beforeEach(() => {
    config.mock.enabled = true;
    config.stripe.subscriptionTransitionsEnabled = false;
    resetMockStore();
    getMockStore().subscriptions.set(
      changeOperation.guildId,
      structuredClone(changePointer),
    );
  });
  afterEach(() => {
    config.mock.enabled = previous.mock;
    config.stripe.subscriptionTransitionsEnabled = previous.transitions;
  });
}
