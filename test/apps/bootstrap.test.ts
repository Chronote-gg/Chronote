/** @jest-environment node */
const mockOrder: string[] = [];
const mockOwner = {
  runStartup: jest.fn(<T>(run: () => Promise<T>) => run()),
};
jest.mock("../../src/observability/langfuseInstrumentation", () => ({}));
jest.mock("../../src/voiceUdpGuard", () => ({}));
jest.mock("../../src/ipv4first", () => ({}));
jest.mock("../../src/services/workerShutdown", () => ({
  installWorkerShutdown: jest.fn(() => {
    mockOrder.push("install");
    return mockOwner;
  }),
}));
jest.mock("../../src/apps/worker", () => ({
  workerResources: { synthetic: "resources" },
  startWorker: jest.fn(async () => {
    mockOrder.push("start");
    return { stop: async () => {} };
  }),
}));
import { bootstrapApp } from "../../src/apps/bootstrap";
import { startWorker, workerResources } from "../../src/apps/worker";
import { installWorkerShutdown } from "../../src/services/workerShutdown";

beforeEach(() => {
  mockOrder.length = 0;
  jest.clearAllMocks();
});

test.each(["all", "bot", "api"] as const)(
  "%s installs the worker shutdown before the worker starts, inside the owned start-up",
  async (mode) => {
    await bootstrapApp(mode);
    expect(mockOrder).toEqual(["install", "start"]);
    expect(installWorkerShutdown).toHaveBeenCalledWith(workerResources);
    expect(startWorker).toHaveBeenCalledWith({ mode });
    expect(mockOwner.runStartup).toHaveBeenCalledTimes(1);
  },
);

test("a start-up failure rejects so the entry point can fail the worker", async () => {
  jest.mocked(startWorker).mockRejectedValueOnce(new Error("login failed"));
  await expect(bootstrapApp("all")).rejects.toThrow("login failed");
});
