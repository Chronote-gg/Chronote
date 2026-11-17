/** @jest-environment node */
import { trpcClient } from "../../src/frontend/services/trpcClient";

afterEach(() => jest.restoreAllMocks());

test("search text travels in the POST body with CSRF and credentials, while other queries stay GET", async () => {
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockImplementation(async (url) => {
      const data = String(url).endsWith("/api/csrf-token")
        ? { csrfToken: "test-csrf" }
        : [{ result: { data: [] } }];
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    });
  const query = "synthetic private search phrase";
  await Promise.all([
    trpcClient.ask.searchMeetings.query({ serverId: "test-server", query }),
    trpcClient.ask.settings.query({ serverId: "test-server" }),
  ]);
  const searchRequest = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("ask.searchMeetings"),
  );
  expect(searchRequest).toBeDefined();
  const [url, options] = searchRequest!;
  expect(decodeURIComponent(String(url))).not.toContain(query);
  expect(
    new URL(String(url), "http://localhost").searchParams.has("input"),
  ).toBe(false);
  expect(options).toMatchObject({ method: "POST", credentials: "include" });
  expect(String(options?.body)).toContain(query);
  expect(new Headers(options?.headers).get("x-csrf-token")).toBe("test-csrf");
  const otherRequest = fetchMock.mock.calls.find(([requestUrl]) =>
    String(requestUrl).includes("ask.settings"),
  );
  expect(otherRequest?.[1]).toMatchObject({
    method: "GET",
    credentials: "include",
  });
});
