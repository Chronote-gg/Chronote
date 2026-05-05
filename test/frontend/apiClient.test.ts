import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { setMockFetchResolved } from "./mocks/fetch";

const loadClient = async (base?: string) => {
  jest.resetModules();
  if (typeof base === "string") {
    (globalThis as { __API_BASE_URL__?: string }).__API_BASE_URL__ = base;
  } else {
    delete (globalThis as { __API_BASE_URL__?: string }).__API_BASE_URL__;
  }
  return await import("../../src/frontend/services/apiClient");
};

describe("apiClient", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("buildApiUrl honors API base when present", async () => {
    const { buildApiUrl, API_BASE } = await loadClient("example.com/api");
    expect(API_BASE).toBe("https://example.com/api");
    expect(buildApiUrl("health")).toBe("https://example.com/api/health");
  });

  test("buildApiUrl returns relative path without base", async () => {
    const { buildApiUrl } = await loadClient("");
    expect(buildApiUrl("health")).toBe("/health");
  });

  test("uses http for localhost base", async () => {
    const { API_BASE } = await loadClient("localhost:3001");
    expect(API_BASE).toBe("http://localhost:3001");
  });

  test("apiFetch returns parsed JSON", async () => {
    const { apiFetch } = await loadClient("");
    setMockFetchResolved({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });

    await expect(apiFetch<{ ok: boolean }>("/ok")).resolves.toEqual({
      ok: true,
    });
  });

  test("apiFetch sets POST for body requests that need CSRF", async () => {
    const { apiFetch } = await loadClient("");
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ csrfToken: "csrf-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      }) as unknown as typeof fetch & jest.Mock;
    global.fetch = fetchMock;

    await expect(
      apiFetch<{ ok: boolean }>("/submit", {
        body: JSON.stringify({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/csrf-token", {
      credentials: "include",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/submit",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
      }),
    );
    const requestInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("x-csrf-token")).toBe(
      "csrf-token",
    );
  });

  test("apiFetch throws AuthNeededError on auth failures", async () => {
    const { apiFetch, AuthNeededError } = await loadClient("");
    setMockFetchResolved({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({}),
    });

    await expect(apiFetch("/secure")).rejects.toBeInstanceOf(AuthNeededError);
  });

  test("apiFetch throws ApiError on non-ok responses", async () => {
    const { apiFetch, ApiError } = await loadClient("");
    setMockFetchResolved({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({}),
    });

    await expect(apiFetch("/boom")).rejects.toBeInstanceOf(ApiError);
  });

  test("apiFetch throws AuthNeededError on non-JSON responses", async () => {
    const { apiFetch, AuthNeededError } = await loadClient("");
    setMockFetchResolved({
      ok: true,
      status: 200,
      text: async () => "not-json",
    });

    await expect(apiFetch("/bad")).rejects.toBeInstanceOf(AuthNeededError);
  });
});
