jest.mock("openai", () => {
  throw new Error("Discord delivery imported OpenAI");
});
import { context as mockContext } from "../deployment/controlFixtures";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ transition: () => {}, settle: () => {} }),
  getRuntimeAdmissionContext: async () => ({
    ...mockContext,
    now: Math.floor(Date.now() / 1000),
  }),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));
export {};
