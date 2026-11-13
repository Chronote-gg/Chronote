/** @jest-environment node */
import {
  mockFailures,
  mockRegistry,
  mockServer,
  mockStarted,
} from "./workerMocks";
import { startWorker } from "../../src/apps/worker";
import { config } from "../../src/services/configService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import { receiptBirth } from "../../src/services/stripeWebhookReceiptService";

const RELEASE = 7;
const METADATA_URI = "http://metadata.test/v4/synthetic";
const ALL_ELIGIBLE_WORK = [
  "finisher",
  "meetingUpdate",
  "processingRetry",
  "personalUpload",
  "renewal",
  "botWork",
];
const original = {
  mock: config.mock.enabled,
  metadataUri: config.runtime.metadataUri,
  ecs: config.runtime.ecs,
};
let metadataRequests = 0;

beforeAll(() => {
  // A real start-up path: the bot logs in, so eligible bot work starts too.
  config.mock.enabled = false;
  config.runtime.ecs = true;
  config.runtime.metadataUri = METADATA_URI;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    metadataRequests += 1;
    expect(String(input)).toBe(`${METADATA_URI}/task`);
    return Response.json({
      TaskARN: "arn:aws:ecs:us-east-1:123456789012:task/synthetic/worker",
      Containers: [],
      Revision: String(RELEASE),
    });
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  config.mock.enabled = original.mock;
  config.runtime.ecs = original.ecs;
  config.runtime.metadataUri = original.metadataUri;
  jest.restoreAllMocks();
});

const becomeEligible = () => {
  mockRegistry.eligible = true;
  for (const listener of mockRegistry.listeners.splice(0)) listener();
};

// One worker per module instance, so these steps share one start, in order.
let worker: Awaited<ReturnType<typeof startWorker>>;

test("nothing polls before the first eligibility", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  worker = await startWorker({ mode: "all" });
  expect(mockRegistry.started).toBe(1);
  expect(mockStarted).toEqual(["webServer", "login"]);
});

test("identity is resolved once and the webhook receipt birth uses it", async () => {
  const birth = await receiptBirth();
  await receiptBirth();
  expect(metadataRequests).toBe(1);
  expect(birth?.writer).toMatchObject({ instanceId: getRuntimeInstanceId() });
});

test("a worker that is ready but not eligible starts no poller and no finisher", async () => {
  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockRegistry.eligible).toBe(false);
  expect(mockStarted).toEqual(["webServer", "login"]);
});

test("on first eligibility every poller, the finisher and the voice channel re-evaluation start once", () => {
  // One start that throws is logged and skips none of the others.
  mockFailures.add("processingRetry");
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  becomeEligible();
  becomeEligible();
  mockFailures.delete("processingRetry");
  expect(mockStarted.slice(2).sort()).toEqual(
    ALL_ELIGIBLE_WORK.filter((job) => job !== "processingRetry").sort(),
  );
  expect(error).toHaveBeenCalledWith(
    "Worker background job failed to start",
    expect.objectContaining({ job: "processing retry" }),
  );
});

test("stop() undoes everything start did", async () => {
  const stopping = worker.stop();
  await jest.advanceTimersByTimeAsync(0);
  await stopping;
  await worker.stop();
  expect(mockRegistry.stopped).toBe(1);
  expect(mockServer.close).toHaveBeenCalledTimes(1);
  const { destroyBot } =
    jest.requireMock<typeof import("../../src/bot")>("../../src/bot");
  expect(destroyBot).toHaveBeenCalledTimes(1);
  const stopped = [
    [
      "../../src/services/processingRetryWorkerService",
      "stopProcessingRetryWorker",
    ],
    [
      "../../src/services/personalMediaUploadWorkerService",
      "stopPersonalMediaUploadWorker",
    ],
    [
      "../../src/services/meetingUpdateDeliveryWorkerService",
      "stopMeetingUpdateDeliveryWorker",
    ],
    [
      "../../src/services/renewalRecoveryWorkerService",
      "stopRenewalRecoveryWorker",
    ],
    [
      "../../src/services/renewalRecoveryWorkerService",
      "releaseRenewalRecoveryLease",
    ],
    [
      "../../src/services/meetingControlWorkerService",
      "stopMeetingControlCommandWorker",
    ],
    ["../../src/services/meetingFinisher", "stopMeetingFinisher"],
  ] as const;
  for (const [module, name] of stopped)
    expect(
      Reflect.get(jest.requireMock<object>(module), name),
    ).toHaveBeenCalledTimes(1);
  // The local sweep was the only timer start-up created here; the pollers are mocked.
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
