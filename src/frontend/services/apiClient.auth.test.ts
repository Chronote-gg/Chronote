/** @jest-environment node */
import { apiFetch, ApiError, AuthNeededError } from "./apiClient";
import { setAuthRequestsAllowed, subscribeAuthTransport } from "./authRecovery";

beforeEach(() => setAuthRequestsAllowed(true));
afterEach(() => jest.restoreAllMocks());
test("forbidden live requests remain permission failures rather than sign-out", async () => {
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response("denied", { status: 403 }));
  await expect(apiFetch("/api/live/fixture/status")).rejects.toBeInstanceOf(
    ApiError,
  );
});
test("an HTML outage does not trigger authentication recovery", async () => {
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response("<html>unavailable</html>"));
  await expect(apiFetch("/api/live/fixture/status")).rejects.not.toBeInstanceOf(
    AuthNeededError,
  );
});
test("a real 401 reports session rejection and paused requests never reach fetch", async () => {
  const fetch = jest
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response("signed out", { status: 401 }));
  const events: string[] = [];
  const stop = subscribeAuthTransport((event) => events.push(event.kind));
  try {
    await expect(apiFetch("/api/live/fixture/status")).rejects.toBeInstanceOf(
      AuthNeededError,
    );
    expect(events).toEqual(["unauthorized"]);
    setAuthRequestsAllowed(false);
    await expect(apiFetch("/api/live/fixture/status")).rejects.toThrow(
      "Sign-in is paused",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});
