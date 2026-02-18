/**
 * @jest-environment node
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

jest.mock("../../src/services/configService", () => ({
  config: { mock: { enabled: true } },
}));
import {
  checkRateLimit,
  _resetRateLimitState,
} from "../../src/trpc/rateLimitMiddleware";

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitState();
  });

  afterEach(() => {
    _resetRateLimitState();
  });

  it("allows requests within the limit", () => {
    expect(checkRateLimit("127.0.0.1", 60_000, 3)).toBe(true);
    expect(checkRateLimit("127.0.0.1", 60_000, 3)).toBe(true);
    expect(checkRateLimit("127.0.0.1", 60_000, 3)).toBe(true);
  });

  it("rejects requests exceeding the limit", () => {
    expect(checkRateLimit("127.0.0.1", 60_000, 2)).toBe(true);
    expect(checkRateLimit("127.0.0.1", 60_000, 2)).toBe(true);
    expect(checkRateLimit("127.0.0.1", 60_000, 2)).toBe(false);
  });

  it("tracks different IPs independently", () => {
    expect(checkRateLimit("1.1.1.1", 60_000, 1)).toBe(true);
    expect(checkRateLimit("2.2.2.2", 60_000, 1)).toBe(true);
    expect(checkRateLimit("1.1.1.1", 60_000, 1)).toBe(false);
    expect(checkRateLimit("2.2.2.2", 60_000, 1)).toBe(false);
  });

  it("resets count after window expires", () => {
    jest.useFakeTimers();

    const windowMs = 1000;
    expect(checkRateLimit("127.0.0.1", windowMs, 1)).toBe(true);
    expect(checkRateLimit("127.0.0.1", windowMs, 1)).toBe(false);

    jest.advanceTimersByTime(windowMs + 1);

    expect(checkRateLimit("127.0.0.1", windowMs, 1)).toBe(true);

    jest.useRealTimers();
  });

  it("handles single-request limit", () => {
    expect(checkRateLimit("127.0.0.1", 60_000, 1)).toBe(true);
    expect(checkRateLimit("127.0.0.1", 60_000, 1)).toBe(false);
  });
});
