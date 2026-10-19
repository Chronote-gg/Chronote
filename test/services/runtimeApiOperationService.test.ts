/** @jest-environment node */
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import {
  beginRuntimeWorkClaim,
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
const mockSettled = jest.fn();
let mockEligible = true;
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => {
    if (!mockEligible) throw new Error("warming");
    return { transition: jest.fn(), settle: mockSettled };
  },
  getRuntimeAdmissionContext: async () => ({ instanceId: "synthetic-api" }),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));
function held<T>() {
  let release!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  return { promise, release, reject };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEligible = true;
  mockCheckAdmission.mockResolvedValue({ kind: "admitted" });
});
test("warm API admission rejects before dispatch", async () => {
  mockEligible = false;
  const provider = jest.fn();
  await expect(
    runRuntimeApiOperation("synthetic-warm", provider),
  ).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();
});
test("a held read stays counted through cancellation and then settles without issuing a mutation", async () => {
  const read = held<void>();
  const entered = held<void>();
  const mutate = jest.fn();
  const task = runRuntimeApiOperation("synthetic-read", async (operation) => {
    entered.release();
    await operation.read(() => read.promise);
    await operation.mutate(mutate);
  });
  const failure = task.catch((error: unknown) => error);
  await entered.promise;
  fenceRuntimeWorkAdmissions();
  expect(mockSettled).not.toHaveBeenCalled();
  read.release();
  await failure;
  expect(mutate).not.toHaveBeenCalled();
  expect(mockSettled).toHaveBeenCalledTimes(1);
  expect(
    getRuntimeWorkAdmissionCheckpoints().find(
      ({ id }) => id === "synthetic-read",
    ),
  ).toBeUndefined();
});
test.each([true, false])(
  "submitted mutation actual ACK=%s decides retention after a process fence",
  async (acknowledged) => {
    const mutation = held<void>();
    const entered = held<void>();
    const id = `synthetic-mutation-${acknowledged}`;
    const task = runRuntimeApiOperation(id, async (operation) => {
      await operation.mutate(() => {
        entered.release();
        return mutation.promise;
      });
    });
    const failure = task.catch((error: unknown) => error);
    await entered.promise;
    fenceRuntimeWorkAdmissions();
    expect(mockSettled).not.toHaveBeenCalled();
    expect(
      getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id)
        ?.effects,
    ).toHaveLength(1);
    if (acknowledged) mutation.release();
    else mutation.reject(new Error("Synthetic submitted mutation ACK lost"));
    await failure;
    expect(mockSettled).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
    if (acknowledged)
      expect(
        getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id),
      ).toBeUndefined();
    else
      expect(
        getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id),
      ).toMatchObject({ fenced: true, localSettled: true });
  },
);

test("local settlement cannot release before the complete registered handler lifetime", async () => {
  const tail = held<void>();
  const entered = held<void>();
  const work = beginRuntimeWorkClaim(
    "api_correction",
    "synthetic-handler-tail",
  );
  const task = work.trackPromise(async () => {
    await work.authority();
    work.claimed();
    await work.settle();
    entered.release();
    await tail.promise;
  });
  try {
    await entered.promise;
    expect(mockSettled).not.toHaveBeenCalled();
    expect(
      getRuntimeWorkAdmissionCheckpoints().find(
        ({ id }) => id === "synthetic-handler-tail",
      ),
    ).toBeDefined();
  } finally {
    tail.release();
    await task;
  }
  expect(mockSettled).toHaveBeenCalledTimes(1);
});

const mockCheckAdmission = jest.fn();
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => ({
    checkAdmission: mockCheckAdmission,
  }),
}));
test("maintenance winning admission prevents the API handler and its effects", async () => {
  mockCheckAdmission.mockResolvedValueOnce({
    kind: "blocked",
    reason: "not_serving",
  });
  const handler = jest.fn();
  await expect(
    runRuntimeApiOperation("maintenance-blocked", handler),
  ).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});
