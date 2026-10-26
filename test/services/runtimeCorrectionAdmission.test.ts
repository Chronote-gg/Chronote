/** @jest-environment node */
import { RuntimeAdmissionUnavailable } from "../../src/services/runtimeAdmissionError";
const mockSettle = jest.fn();
let mockRetainedOld = true;
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => {
    if (mockRetainedOld)
      throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
    return { transition: jest.fn(), settle: mockSettle };
  },
  getRuntimeAdmissionContext: async () => {
    throw new RuntimeAdmissionUnavailable("Runtime is not serving");
  },
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));
import { correctionProcedure, router } from "../../src/trpc/trpc";
import type { TrpcContext } from "../../src/trpc/context";

test.each([true, false])(
  "retained old API admission local=%s returns typed retryable errors without dispatch",
  async (local) => {
    mockRetainedOld = local;
    const effect = jest.fn();
    const api = router({ correct: correctionProcedure.mutation(effect) });
    const caller = api.createCaller({
      user: { id: "user", accessToken: "test" },
    } as TrpcContext);
    await expect(caller.correct()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Recording service is switching. Please retry.",
    });
    expect(effect).not.toHaveBeenCalled();
  },
);
