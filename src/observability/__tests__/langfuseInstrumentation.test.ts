/** @jest-environment node */
const mockStart = jest.fn();
const mockFlush = jest.fn(async () => {});
const mockShutdown = jest.fn();
jest.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: jest.fn(() => ({ start: mockStart, shutdown: mockShutdown })),
}));
jest.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: jest.fn(() => ({ forceFlush: mockFlush })),
}));
jest.mock("../../services/configService", () => ({
  config: {
    langfuse: {
      publicKey: "",
      secretKey: "",
      baseUrl: "https://us.cloud.langfuse.com",
      tracingEnabled: true,
      tracingEnvironment: "sandbox",
      release: "release-sha",
    },
  },
}));
import { config } from "../../services/configService";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startLangfuseTracing,
  flushLangfuseTracing,
} from "../langfuseInstrumentation";

test("starts once after secret hydration and flushes without shutting down the warm provider", async () => {
  expect(NodeSDK).not.toHaveBeenCalled();
  config.langfuse.publicKey = "synthetic-public";
  config.langfuse.secretKey = "synthetic-secret";
  startLangfuseTracing();
  startLangfuseTracing();
  expect(LangfuseSpanProcessor).toHaveBeenCalledWith(
    expect.objectContaining({
      publicKey: "synthetic-public",
      secretKey: "synthetic-secret",
      baseUrl: "https://us.cloud.langfuse.com",
      environment: "sandbox",
      release: "release-sha",
    }),
  );
  expect(NodeSDK).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
  await flushLangfuseTracing();
  await flushLangfuseTracing();
  expect(mockFlush).toHaveBeenCalledTimes(2);
  expect(mockShutdown).not.toHaveBeenCalled();
});
