/** @jest-environment node */
import { createOpenAIClient } from "../openaiClient";
import { startObservation } from "@langfuse/tracing";
import { isLangfuseTracingEnabled } from "../langfuseClient";
import {
  embedSearchText,
  embedSearchTexts,
  searchEmbeddingInputHash,
} from "../searchEmbeddingService";
jest.mock("../openaiClient", () => ({ createOpenAIClient: jest.fn() }));
const mockUpdate = jest.fn();
const mockEnd = jest.fn();
jest.mock("@langfuse/tracing", () => ({
  startObservation: jest.fn(() => ({ update: mockUpdate, end: mockEnd })),
}));
jest.mock("../langfuseClient", () => ({
  isLangfuseTracingEnabled: jest.fn(() => true),
}));
const create = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isLangfuseTracingEnabled).mockReturnValue(true);
  jest
    .mocked(createOpenAIClient)
    .mockReturnValue({ embeddings: { create } } as unknown as ReturnType<
      typeof createOpenAIClient
    >);
  create.mockResolvedValue({
    model: "text-embedding-3-small",
    data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
    usage: { prompt_tokens: 3, total_tokens: 3 },
  });
});
test("uses explicit model and dimensions with bounded retries and cancellation", async () => {
  const signal = new AbortController().signal;
  await expect(
    embedSearchText("meeting text <|endoftext|>", signal),
  ).resolves.toHaveLength(1536);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "text-embedding-3-small",
      dimensions: 1536,
      input: ["meeting text <|endoftext|>"],
    }),
    { signal, maxRetries: 2, timeout: 45_000 },
  );
});
test("rejects oversized input before a paid request, never truncates", async () => {
  await expect(embedSearchText(" word".repeat(8193))).rejects.toThrow("8192");
  expect(create).not.toHaveBeenCalled();
});
test.each([
  { model: "wrong", data: [{ embedding: Array(1536).fill(0.1) }] },
  { model: "text-embedding-3-small", data: [{ embedding: [0.1] }] },
  {
    model: "text-embedding-3-small",
    data: [{ embedding: Array(1536).fill(NaN) }],
  },
])("rejects incompatible provider output", async (response) => {
  create.mockResolvedValue(response);
  await expect(embedSearchText("text")).rejects.toThrow("mismatch");
});
test("aborted work never calls the provider; hashes bind exact input", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(embedSearchText("text", abort.signal)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(searchEmbeddingInputHash("text")).toBe(
    searchEmbeddingInputHash("text"),
  );
  expect(searchEmbeddingInputHash("text")).not.toBe(
    searchEmbeddingInputHash("text "),
  );
});

test("batches at 32 inputs and uses provider indexes to preserve input order", async () => {
  create.mockImplementation(async ({ input }: { input: string[] }) => ({
    model: "text-embedding-3-small",
    data: input
      .map((text, index) => ({
        index,
        embedding: Array(1536).fill(Number(text)),
      }))
      .reverse(),
  }));
  const result = await embedSearchTexts(
    Array.from({ length: 33 }, (_, index) => String(index)),
  );
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0].input).toHaveLength(32);
  expect(result.map((vector) => vector[0])).toEqual(
    Array.from({ length: 33 }, (_, index) => index),
  );
});

test("records paid embedding usage once without vectors or text in telemetry", async () => {
  await embedSearchText("private meeting text");
  expect(createOpenAIClient).toHaveBeenCalledWith({ disableTracing: true });
  expect(startObservation).toHaveBeenCalledWith(
    "meeting-search-embedding",
    {
      model: "text-embedding-3-small",
      metadata: { inputCount: 1, dimensions: 1536 },
    },
    { asType: "embedding" },
  );
  expect(mockUpdate).toHaveBeenCalledWith({
    usageDetails: { input: 3, total: 3 },
  });
  expect(mockEnd).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(jest.mocked(startObservation).mock.calls),
  ).not.toContain("private meeting text");
});

test("ends a failed embedding observation with a sanitized failure; tracing can be disabled", async () => {
  create.mockRejectedValueOnce(Error("private provider body"));
  await expect(embedSearchText("private text")).rejects.toThrow(
    "private provider body",
  );
  expect(mockUpdate).toHaveBeenLastCalledWith({
    level: "ERROR",
    statusMessage: "Embedding request failed",
  });
  expect(mockEnd).toHaveBeenCalledTimes(1);
  jest.mocked(startObservation).mockClear();
  jest.mocked(isLangfuseTracingEnabled).mockReturnValue(false);
  await embedSearchText("text");
  expect(startObservation).not.toHaveBeenCalled();
});
