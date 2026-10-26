/** @jest-environment node */
import {
  verifyMeetingUpdateDeliveryReadiness,
  prepareMeetingUpdateDeliveryWorker,
  startMeetingUpdateDeliveryWorker,
} from "../../src/services/meetingUpdateDeliveryWorkerService";
import { stripeTransport } from "../fixtures/stripeTransport";
import { getStripeClient } from "../../src/services/stripeClient";
import {
  startRenewalRecoveryWorker,
  verifyRenewalRecoveryReadiness,
} from "../../src/services/renewalRecoveryWorkerService";
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  startMeetingUpdateDeliveryWorker: jest.fn(),
  prepareMeetingUpdateDeliveryWorker: jest.fn(async () => {}),
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  whenRuntimeServing: (listener: () => void) => listener(),
}));
jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: jest.fn(),
}));
jest.mock("../../src/services/renewalRecoveryWorkerService", () => ({
  startRenewalRecoveryWorker: jest.fn(),
  verifyRenewalRecoveryReadiness: jest.fn(async () => undefined),
}));
import { createProcessShutdownOwner } from "../../src/services/processShutdownService";
import { createRuntimeShutdown } from "../../src/services/runtimeShutdownService";
const mockExit = jest.fn();
const mockOwners: ReturnType<typeof createProcessShutdownOwner>[] = [];
jest.mock(
  "../../src/services/runtimeShutdownService",
  () => ({
    createRuntimeShutdown: jest.fn(() => {
      const owner = createProcessShutdownOwner({
        closeAdmission: jest.fn(),
        preserve: async () => true,
        flush: async () => {},
        exit: mockExit,
      });
      owner.installSignalHandlers(process);
      mockOwners.push(owner);
      return owner;
    }),
  }),
  { virtual: true },
);
jest.mock("../../src/observability/langfuseInstrumentation", () => ({}));
jest.mock("../../src/voiceUdpGuard", () => ({}));
jest.mock("../../src/ipv4first", () => ({}));
jest.mock("../../src/bot", () => ({
  setupBot: jest.fn(),
  isBotGatewayReady: jest.fn(() => false),
}));
jest.mock("../../src/webserver", () => ({ setupWebServer: jest.fn() }));
jest.mock("../../src/services/runtimeHealthServer", () => ({
  startRuntimeHealthServer: jest.fn(),
}));
jest.mock("../../src/services/configService", () => ({
  config: {
    mock: { enabled: false },
    runtime: { ecs: false },
    server: { port: 3001 },
  },
}));
jest.mock("../../src/services/langfusePromptService", () => ({
  verifyLangfusePrompts: jest.fn(),
}));
jest.mock("../../src/services/tempFileService", () => ({
  cleanupTempBaseDir: jest.fn(),
}));
jest.mock("../../src/services/runtimeStartupService", () => ({
  initializeRuntimeLifecycle: jest.fn(),
}));
import { bootstrapApp } from "../../src/apps/bootstrap";
import { setupBot } from "../../src/bot";
import { setupWebServer } from "../../src/webserver";
import { initializeRuntimeLifecycle } from "../../src/services/runtimeStartupService";
import { startRuntimeHealthServer } from "../../src/services/runtimeHealthServer";
import { config } from "../../src/services/configService";
import { verifyLangfusePrompts } from "../../src/services/langfusePromptService";

afterEach(() => {
  for (const owner of mockOwners.splice(0)) owner.dispose();
});

beforeEach(() => {
  jest.clearAllMocks();
  config.runtime.ecs = false;
  jest.mocked(getStripeClient).mockReturnValue(
    stripeTransport(() => {
      throw new Error("Unexpected Stripe request");
    }).stripe,
  );
});

test.each(["all", "bot", "api"] as const)(
  "%s uses one health listener and no application boot before protection",
  async (mode) => {
    config.runtime.ecs = true;
    const health = {
      server: {} as Awaited<
        ReturnType<typeof startRuntimeHealthServer>
      >["server"],
      activate: jest.fn(),
      close: jest.fn(),
    };
    jest.mocked(startRuntimeHealthServer).mockResolvedValue(health);
    let finish!: (
      value: Awaited<ReturnType<typeof initializeRuntimeLifecycle>>,
    ) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const protection = new Promise<
      Awaited<ReturnType<typeof initializeRuntimeLifecycle>>
    >((resolve) => {
      finish = resolve;
    });
    jest.mocked(initializeRuntimeLifecycle).mockImplementation(() => {
      entered();
      return protection;
    });
    jest.mocked(setupBot).mockResolvedValue(undefined);
    const boot = bootstrapApp(mode);
    await waiting;
    expect(startRuntimeHealthServer).toHaveBeenCalledTimes(1);
    expect(setupBot).not.toHaveBeenCalled();
    expect(setupWebServer).not.toHaveBeenCalled();
    expect(verifyLangfusePrompts).not.toHaveBeenCalled();
    const ready = jest.fn();
    finish({ ready, failed: jest.fn() });
    await boot;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(verifyMeetingUpdateDeliveryReadiness).toHaveBeenCalledTimes(1);
    expect(startMeetingUpdateDeliveryWorker).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(verifyMeetingUpdateDeliveryReadiness).mock
        .invocationCallOrder[0],
    ).toBeLessThan(ready.mock.invocationCallOrder[0]);
    if (mode !== "bot") {
      expect(verifyRenewalRecoveryReadiness).toHaveBeenCalledTimes(1);
      expect(
        jest.mocked(verifyRenewalRecoveryReadiness).mock.invocationCallOrder[0],
      ).toBeLessThan(ready.mock.invocationCallOrder[0]);
      expect(
        jest.mocked(startRenewalRecoveryWorker).mock.invocationCallOrder[0],
      ).toBeGreaterThan(ready.mock.invocationCallOrder[0]);
    } else expect(startRenewalRecoveryWorker).not.toHaveBeenCalled();
    if (mode !== "bot") expect(setupWebServer).toHaveBeenCalledWith(health);
    else expect(setupWebServer).not.toHaveBeenCalled();
  },
);

test("gateway login failure cannot publish ready startup", async () => {
  const ready = jest.fn();
  const failed = jest.fn();
  jest.mocked(initializeRuntimeLifecycle).mockResolvedValue({ ready, failed });
  jest.mocked(setupBot).mockRejectedValue(new Error("login failed"));
  await expect(bootstrapApp("all")).rejects.toThrow("login failed");
  expect(ready).not.toHaveBeenCalled();
  expect(setupWebServer).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
});

test("startup waits for gateway login after establishing protection", async () => {
  let finish!: () => void;
  const login = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const loginStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ready = jest.fn();
  const failed = jest.fn();
  jest.mocked(initializeRuntimeLifecycle).mockResolvedValue({ ready, failed });
  jest.mocked(setupBot).mockImplementation(async () => {
    started();
    await login;
  });
  const boot = bootstrapApp("all");
  await loginStarted;
  expect(initializeRuntimeLifecycle).toHaveBeenCalledTimes(1);
  expect(ready).not.toHaveBeenCalled();
  expect(setupWebServer).not.toHaveBeenCalled();
  finish();
  await boot;
  expect(ready).toHaveBeenCalledTimes(1);
});

test("API-only mode has no gateway login dependency", async () => {
  const ready = jest.fn();
  jest
    .mocked(initializeRuntimeLifecycle)
    .mockImplementation(async (gatewayReady) => {
      expect(gatewayReady()).toBe(false);
      return { ready, failed: jest.fn() };
    });
  await bootstrapApp("api");
  expect(setupBot).not.toHaveBeenCalled();
  expect(setupWebServer).toHaveBeenCalledTimes(1);
  expect(ready).toHaveBeenCalledTimes(1);
});

test("signal owner is installed before held health listen and waits late server close before exit", async () => {
  config.runtime.ecs = true;
  let listen!: (
    server: Awaited<ReturnType<typeof startRuntimeHealthServer>>,
  ) => void;
  const health = {
    server: {} as Awaited<
      ReturnType<typeof startRuntimeHealthServer>
    >["server"],
    activate: jest.fn(),
    close: jest.fn(async () => {}),
  };
  jest.mocked(startRuntimeHealthServer).mockReturnValue(
    new Promise((resolve) => {
      listen = resolve;
    }),
  );
  jest
    .mocked(initializeRuntimeLifecycle)
    .mockResolvedValue({ ready: jest.fn(), failed: jest.fn() });
  const boot = bootstrapApp("api");
  const rejected = boot.catch((error: unknown) => error);
  try {
    expect(createRuntimeShutdown).toHaveBeenCalledTimes(1);
    process.emit("SIGTERM");
    expect(mockOwners[0].startupSignal.aborted).toBe(true);
    expect(mockExit).not.toHaveBeenCalled();
  } finally {
    listen(health);
    await rejected;
  }
  await mockOwners[0].request("signal");
  expect(initializeRuntimeLifecycle).not.toHaveBeenCalled();
  expect(setupWebServer).not.toHaveBeenCalled();
  expect(health.close).toHaveBeenCalledTimes(1);
  expect(mockExit).toHaveBeenCalledTimes(1);
});

test("startup failure starts the budget before a held server close can finish", async () => {
  config.runtime.ecs = true;
  let close!: () => void;
  let closing!: () => void;
  const started = new Promise<void>((resolve) => {
    closing = resolve;
  });
  const health = {
    server: {} as Awaited<
      ReturnType<typeof startRuntimeHealthServer>
    >["server"],
    activate: jest.fn(),
    close: jest.fn(() => {
      closing();
      return new Promise<void>((resolve) => {
        close = resolve;
      });
    }),
  };
  jest.mocked(startRuntimeHealthServer).mockResolvedValue(health);
  jest
    .mocked(initializeRuntimeLifecycle)
    .mockRejectedValue(new Error("Synthetic protection failure"));
  const boot = bootstrapApp("api").catch((error: unknown) => error);
  await started;
  try {
    expect(mockOwners[0].startupSignal.aborted).toBe(true);
    expect(mockExit).not.toHaveBeenCalled();
  } finally {
    close();
    await boot;
  }
  await mockOwners[0].request("startup_failure");
  expect(mockExit).toHaveBeenCalledWith(1);
});

test("meeting delivery index failure blocks every runtime before application activation", async () => {
  const ready = jest.fn(),
    failed = jest.fn();
  jest.mocked(startRuntimeHealthServer).mockResolvedValue(readyHealth());
  jest.mocked(initializeRuntimeLifecycle).mockResolvedValue({ ready, failed });
  jest
    .mocked(verifyMeetingUpdateDeliveryReadiness)
    .mockRejectedValueOnce(Error("Index not ACTIVE"));
  await expect(bootstrapApp("api")).rejects.toThrow("Index not ACTIVE");
  expect(setupWebServer).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  expect(startMeetingUpdateDeliveryWorker).not.toHaveBeenCalled();
});

test.each(["all", "bot", "api"] as const)(
  "meeting delivery starts in %s without billing",
  async (mode) => {
    const ready = jest.fn();
    jest.mocked(getStripeClient).mockReturnValue(null);
    jest
      .mocked(initializeRuntimeLifecycle)
      .mockResolvedValue({ ready, failed: jest.fn() });
    jest.mocked(startRuntimeHealthServer).mockResolvedValue(readyHealth());
    jest.mocked(setupBot).mockResolvedValue(undefined);
    await bootstrapApp(mode);
    expect(verifyMeetingUpdateDeliveryReadiness).toHaveBeenCalledTimes(1);
    expect(startMeetingUpdateDeliveryWorker).toHaveBeenCalledTimes(1);
    expect(startRenewalRecoveryWorker).not.toHaveBeenCalled();
  },
);

function readyHealth() {
  return {
    server: {} as Awaited<
      ReturnType<typeof startRuntimeHealthServer>
    >["server"],
    activate: jest.fn(),
    close: jest.fn(async () => {}),
  };
}

test("delivery preparation failure cannot publish a ready runtime", async () => {
  const ready = jest.fn();
  const failed = jest.fn();
  jest.mocked(initializeRuntimeLifecycle).mockResolvedValue({ ready, failed });
  jest
    .mocked(prepareMeetingUpdateDeliveryWorker)
    .mockRejectedValueOnce(new Error("delivery repository unavailable"));
  await expect(bootstrapApp("api")).rejects.toThrow(
    "delivery repository unavailable",
  );
  expect(ready).not.toHaveBeenCalled();
  expect(startMeetingUpdateDeliveryWorker).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
});
