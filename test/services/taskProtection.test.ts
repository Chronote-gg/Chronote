/** @jest-environment node */
jest.mock("../../src/services/configService", () => ({
  config: { runtime: { agentUri: "" } },
}));

import { metricsRegistry, TASK_PROTECTION_FAILED_LOG } from "../../src/metrics";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  configureCaptureProtection,
  createTaskProtection,
  getProtectedUntil,
  releaseCaptureProtection,
  requestCaptureProtection,
} from "../../src/services/taskProtection";

const NOW_SECONDS = 1_800_000_000;
const CAP_SECONDS = NOW_SECONDS + 7_200;
const TASK_ARN = "arn:aws:ecs:us-east-1:000000000000:task/test/synthetic";

function protectionBody(enabled: boolean, expiresAtSeconds?: number) {
  return {
    protection: {
      TaskArn: TASK_ARN,
      ProtectionEnabled: enabled,
      ExpirationDate:
        expiresAtSeconds === undefined
          ? null
          : new Date(expiresAtSeconds * 1000).toISOString(),
    },
  };
}

function sentBody(request: jest.Mock, call = 0): unknown {
  const init: RequestInit = request.mock.calls[call][1];
  return JSON.parse(String(init.body));
}

async function failureCount(): Promise<number> {
  const metric = await metricsRegistry
    .getSingleMetric("worker_task_protection_total")
    ?.get();
  return (
    metric?.values.find((value) => value.labels.outcome === "failure")?.value ??
    0
  );
}

/** Protection that retries through a sleep the test releases, under a fixed lease cap. */
function retryingProtection(request: jest.Mock) {
  const timer = manualSleep();
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    sleep: timer.sleep,
    latestLeaseCap: () => CAP_SECONDS,
  });
  return { timer, protection };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A sleep that resolves only when the test lets it, so no real timer runs. */
function manualSleep() {
  const waits: Array<{ ms: number; resolve: () => void }> = [];
  const sleep = jest.fn(
    (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        waits.push({ ms, resolve });
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  return {
    sleep,
    waits,
    async tick() {
      await flush();
      waits.shift()?.resolve();
      await flush();
    },
  };
}

let errorLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

test("expiry is ten minutes past the latest cap", async () => {
  const confirmedUntil = CAP_SECONDS + LIFECYCLE.protectionPastCapSeconds;
  const request = jest.fn(async () =>
    Response.json(protectionBody(true, confirmedUntil)),
  );
  const latestLeaseCap = jest.fn(() => CAP_SECONDS);
  const protection = createTaskProtection({
    agentUri: "http://agent/",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap,
  });

  await expect(protection.ensure()).resolves.toBe(true);

  expect(latestLeaseCap).toHaveBeenCalledWith(NOW_SECONDS);
  expect(request.mock.calls[0][0]).toBe(
    "http://agent/task-protection/v1/state",
  );
  expect(sentBody(request)).toEqual({
    ProtectionEnabled: true,
    ExpiresInMinutes: 130,
  });
  expect(protection.protectedUntil()).toBe(confirmedUntil);
});

test("expiry rounds up to whole minutes", async () => {
  const request = jest.fn(async () =>
    Response.json(protectionBody(true, NOW_SECONDS + 1_000)),
  );
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap: () => NOW_SECONDS + 1,
  });

  await protection.ensure();

  expect(sentBody(request)).toEqual({
    ProtectionEnabled: true,
    ExpiresInMinutes: 11,
  });
});

test("refused call is counted and not thrown", async () => {
  const before = await failureCount();
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { failure: { Arn: TASK_ARN, Reason: "DEPLOYMENT_BLOCKED" } },
        { status: 400 },
      ),
    )
    .mockRejectedValueOnce(new Error("agent unreachable"))
    .mockResolvedValueOnce(Response.json(protectionBody(false)));
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap: () => CAP_SECONDS,
  });

  await expect(protection.ensure()).resolves.toBe(false);
  await expect(protection.ensure()).resolves.toBe(false);
  await expect(protection.ensure()).resolves.toBe(false);

  expect(await failureCount()).toBe(before + 3);
  expect(errorLog).toHaveBeenCalledTimes(3);
  const lines = errorLog.mock.calls.map(([line]) => String(line));
  for (const line of lines)
    expect(line.startsWith(TASK_PROTECTION_FAILED_LOG)).toBe(true);
  expect(lines[0]).toContain("400");
  expect(lines[0]).toContain("DEPLOYMENT_BLOCKED");
  expect(lines[1]).toContain("agent unreachable");
  expect(protection.protectedUntil()).toBeUndefined();
});

test("a throwing lease cap is a counted failure, not a rejection", async () => {
  const before = await failureCount();
  const request = jest.fn();
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap: () => {
      throw new Error("lease state unreadable");
    },
  });

  await expect(protection.ensure()).resolves.toBe(false);

  expect(request).not.toHaveBeenCalled();
  expect(await failureCount()).toBe(before + 1);
  expect(String(errorLog.mock.calls[0][0])).toMatch(
    new RegExp(`^${TASK_PROTECTION_FAILED_LOG}.*lease state unreadable`),
  );
});

test("an enable and a disable reach the agent in the order they were asked", async () => {
  const sent: unknown[] = [];
  let answerFirst: (() => void) | undefined;
  const request = jest.fn(async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body));
    if (!answerFirst)
      await new Promise<void>((resolve) => {
        answerFirst = resolve;
      });
    sent.push(body);
    return Response.json(protectionBody(false));
  });
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap: () => CAP_SECONDS,
  });

  const enabling = protection.ensure();
  const clearing = protection.clear();
  await flush();
  expect(request).toHaveBeenCalledTimes(1);
  answerFirst?.();
  await Promise.all([enabling, clearing]);

  expect(sent).toEqual([
    { ProtectionEnabled: true, ExpiresInMinutes: 130 },
    { ProtectionEnabled: false },
  ]);
});

test("no extension without an unexpired lease", async () => {
  const request = jest.fn(async () =>
    Response.json(protectionBody(true, CAP_SECONDS)),
  );
  let cap: number | undefined = CAP_SECONDS;
  const protection = createTaskProtection({
    agentUri: "http://agent",
    request,
    now: () => NOW_SECONDS,
    latestLeaseCap: () => cap,
  });
  await protection.ensure();
  expect(request).toHaveBeenCalledTimes(1);

  // The lease has reached its cap, though a capture is still believed live.
  cap = undefined;

  await expect(protection.ensure()).resolves.toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

test("clear retries until success", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error("agent unreachable"))
    .mockResolvedValueOnce(Response.json({}, { status: 500 }))
    .mockResolvedValueOnce(Response.json(protectionBody(false)));
  const { timer, protection } = retryingProtection(request);

  const cleared = protection.clear();
  await timer.tick();
  await timer.tick();
  await cleared;

  expect(request).toHaveBeenCalledTimes(3);
  expect(sentBody(request, 2)).toEqual({ ProtectionEnabled: false });
  expect(timer.sleep).toHaveBeenCalledTimes(2);
  expect(timer.sleep.mock.calls[0][0]).toBe(LIFECYCLE.protectionRetryMs);
  expect(protection.protectedUntil()).toBeUndefined();
});

test("a live capture retries until protection succeeds", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error("agent unreachable"))
    .mockResolvedValueOnce(Response.json(protectionBody(true, CAP_SECONDS)));
  const { timer, protection } = retryingProtection(request);

  await protection.requestCapture();
  expect(protection.protectedUntil()).toBeUndefined();
  await timer.tick();

  expect(request).toHaveBeenCalledTimes(2);
  expect(protection.protectedUntil()).toBe(CAP_SECONDS);
  expect(timer.waits).toHaveLength(0);
});

test("releasing the capture stops the retry and clears", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error("agent unreachable"))
    .mockResolvedValueOnce(Response.json(protectionBody(false)));
  const { timer, protection } = retryingProtection(request);

  await protection.requestCapture();
  await protection.releaseCapture();

  expect(request).toHaveBeenCalledTimes(2);
  expect(sentBody(request, 1)).toEqual({ ProtectionEnabled: false });
  expect(timer.waits).toHaveLength(1);
  await timer.tick();
  expect(request).toHaveBeenCalledTimes(2);
});

test("outside ECS every call is a no-op", async () => {
  const request = jest.fn();
  const protection = createTaskProtection({
    agentUri: "",
    request,
    latestLeaseCap: () => CAP_SECONDS,
  });

  await expect(protection.ensure()).resolves.toBe(false);
  await protection.requestCapture();
  await protection.clear();

  expect(request).not.toHaveBeenCalled();
  expect(protection.protectedUntil()).toBeUndefined();
});

test("the unconfigured singleton behaves as no live lease", async () => {
  await requestCaptureProtection();
  releaseCaptureProtection();
  expect(getProtectedUntil()).toBeUndefined();

  configureCaptureProtection({ latestLeaseCap: () => CAP_SECONDS });
  await requestCaptureProtection();
  expect(getProtectedUntil()).toBeUndefined();
});
