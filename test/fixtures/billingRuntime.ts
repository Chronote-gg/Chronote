import { getMockStore } from "../../src/repositories/mockStore";
import { context, control, runtime } from "../deployment/controlFixtures";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: async () =>
    jest.requireActual<typeof import("../deployment/controlFixtures")>(
      "../deployment/controlFixtures",
    ).context,
  getRuntimeReadiness: () =>
    jest
      .requireActual<typeof import("../deployment/controlFixtures")>(
        "../deployment/controlFixtures",
      )
      .runtime("old").readiness,
}));
export function seedBillingRuntime() {
  const records = getMockStore().deploymentControlRecords;
  for (const row of [control, runtime("old")])
    records.set(JSON.stringify([row.pk, row.sk]), structuredClone(row));
}
export { context };
