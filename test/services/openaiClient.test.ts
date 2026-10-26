/** @jest-environment node */
import { createHmac } from "node:crypto";
import {
  buildOpenAISafetyIdentifier,
  createOpenAIClient,
} from "../../src/services/openaiClient";
import { config } from "../../src/services/configService";

beforeEach(() => {
  jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected native transport"));
});
afterEach(() => jest.restoreAllMocks());

describe("buildOpenAISafetyIdentifier", () => {
  test("returns a stable keyed pseudonymous identifier", () => {
    const first = buildOpenAISafetyIdentifier("123456789012345678");
    const second = buildOpenAISafetyIdentifier(" 123456789012345678 ");

    expect(first).toBe(second);
    expect(first).toBe(
      createHmac("sha256", "test-oauth-secret")
        .update("chronote:openai-safety:v1:123456789012345678")
        .digest("hex"),
    );
    expect(buildOpenAISafetyIdentifier("987654321098765432")).not.toBe(first);
    expect(first).not.toContain("123456789012345678");
  });

  test("omits an identifier when no end user is available", () => {
    expect(buildOpenAISafetyIdentifier()).toBeUndefined();
    expect(buildOpenAISafetyIdentifier("   ")).toBeUndefined();
  });
});

test("optional fetch preserves API credentials and delegates the request", async () => {
  const fetch = jest.fn(async () => Response.json({ data: [] }));
  const client = createOpenAIClient({ disableTracing: true }, { fetch });
  await client.models.list();
  expect(client.apiKey).toBe(config.openai.apiKey);
  expect(client.organization).toBe(config.openai.organizationId ?? null);
  expect(client.project).toBe(config.openai.projectId ?? null);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.maxRetries).toBe(2);
});

test("factory retains default client options without a transport override", () => {
  const client = createOpenAIClient({ disableTracing: true });
  expect(client.apiKey).toBe(config.openai.apiKey);
  expect(client.maxRetries).toBe(2);
  expect(client.timeout).toBe(600_000);
});

test("Responses requests retain SDK retry behavior with an injected transport", async () => {
  let calls = 0;
  const fetch = jest.fn(async () => {
    calls += 1;
    return calls === 1
      ? Response.json(
          { error: { message: "synthetic unavailable" } },
          { status: 503, headers: { "retry-after-ms": "1" } },
        )
      : Response.json({ id: "synthetic-response", output: [] });
  });
  const client = createOpenAIClient({ disableTracing: true }, { fetch });
  await client.responses.create({
    model: "synthetic-text",
    input: "synthetic",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(client.maxRetries).toBe(2);
});

test("factory forwards explicitly configured organization and project headers", async () => {
  const organizationId = config.openai.organizationId;
  const projectId = config.openai.projectId;
  let headers = new Headers();
  const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return Response.json({ data: [] });
  });
  try {
    config.openai.organizationId = "synthetic-organization";
    config.openai.projectId = "synthetic-project";
    const client = createOpenAIClient({ disableTracing: true }, { fetch });
    await client.models.list();
    expect(headers.get("openai-organization")).toBe("synthetic-organization");
    expect(headers.get("openai-project")).toBe("synthetic-project");
    expect(headers.get("authorization")).toBe(`Bearer ${config.openai.apiKey}`);
  } finally {
    config.openai.organizationId = organizationId;
    config.openai.projectId = projectId;
  }
});
