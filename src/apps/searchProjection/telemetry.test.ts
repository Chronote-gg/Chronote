/** @jest-environment node */
const mockStart = jest.fn();
const mockFlush = jest.fn(async () => {});
jest.mock("../../observability/langfuseInstrumentation", () => ({
  startLangfuseTracing: mockStart,
  flushLangfuseTracing: mockFlush,
}));
jest.mock("../../services/searchEmbeddingService", () => ({
  embedSearchTexts: jest.fn(),
}));
jest.mock("../../services/configService", () => ({
  config: {
    search: {
      langfusePublicKeySecretArn: "public-arn",
      langfuseSecretKeySecretArn: "secret-arn",
    },
    langfuse: { publicKey: "", secretKey: "" },
  },
}));
import { config } from "../../services/configService";
import {
  initializeSearchProjectionTelemetry,
  createSearchProjectionHandler,
} from "./main";

test("fetches both keys before tracing startup and returns a reusable flush", async () => {
  const read = jest.fn(async (arn: string) =>
    arn === "public-arn" ? "synthetic-public" : "synthetic-secret",
  );
  mockStart.mockImplementation(() => {
    expect(config.langfuse.publicKey).toBe("synthetic-public");
    expect(config.langfuse.secretKey).toBe("synthetic-secret");
  });
  const flush = await initializeSearchProjectionTelemetry(read);
  expect(read.mock.calls).toEqual([["public-arn"], ["secret-arn"]]);
  expect(mockStart).toHaveBeenCalledTimes(1);
  await flush();
  expect(mockFlush).toHaveBeenCalledTimes(1);
});

test("flushes on successful and failed invocations without making telemetry a processing failure", async () => {
  const flushTelemetry = jest.fn(async () => {
    throw Error("telemetry unavailable");
  });
  const success = createSearchProjectionHandler({
    project: jest.fn(),
    reconcile: jest.fn(),
    flushTelemetry,
  });
  await expect(success({})).resolves.toEqual({ batchItemFailures: [] });
  const fail = createSearchProjectionHandler({
    project: jest.fn(),
    reconcile: jest.fn(async () => {
      throw Error("source failure");
    }),
    flushTelemetry,
  });
  await expect(fail({})).rejects.toThrow("source failure");
  expect(flushTelemetry).toHaveBeenCalledTimes(2);
});

test("a hung telemetry export is bounded and never shuts down warm tracing", async () => {
  jest.useFakeTimers();
  try {
    const flushTelemetry = jest.fn(() => new Promise<void>(() => {}));
    const handler = createSearchProjectionHandler({
      project: jest.fn(),
      reconcile: jest.fn(),
      flushTelemetry,
    });
    const result = handler({});
    await jest.advanceTimersByTimeAsync(2001);
    await expect(result).resolves.toEqual({ batchItemFailures: [] });
  } finally {
    jest.useRealTimers();
  }
});
