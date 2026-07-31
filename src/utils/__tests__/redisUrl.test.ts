import { isUsableRedisUrl } from "../redisUrl";

describe("isUsableRedisUrl", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("accepts a TLS URL for a managed provider", () => {
    expect(
      isUsableRedisUrl("rediss://default:pw@more-corgi.upstash.io:6379"),
    ).toBe(true);
    expect(
      isUsableRedisUrl("rediss://:tok@master.x.use1.cache.amazonaws.com:6379"),
    ).toBe(true);
  });

  it("rejects a plaintext URL pointed at a remote host", () => {
    // The production incident: Upstash's console shows the connection string as
    // redis:// because its example passes --tls separately, and ioredis then
    // connects without TLS and retries a reset socket forever.
    expect(
      isUsableRedisUrl("redis://default:pw@more-corgi.upstash.io:6379"),
    ).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("more-corgi.upstash.io"),
    );
  });

  it("allows plaintext for local development hosts", () => {
    // docker-compose runs redis:8-alpine without TLS.
    expect(isUsableRedisUrl("redis://localhost:6379")).toBe(true);
    expect(isUsableRedisUrl("redis://127.0.0.1:6379")).toBe(true);
    expect(isUsableRedisUrl("redis://redis:6379")).toBe(true);
  });

  it("treats an empty or malformed URL as no cache", () => {
    expect(isUsableRedisUrl("")).toBe(false);
    expect(isUsableRedisUrl("not-a-url")).toBe(false);
  });
});
