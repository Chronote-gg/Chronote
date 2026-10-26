/** @jest-environment node */
const ping = jest.fn();
jest.mock("ioredis", () =>
  jest.fn().mockImplementation(() => ({ on: jest.fn(), ping })),
);
const cacheConfig = {
  enabled: true,
  redisUrl: "",
  keyPrefix: "test",
  referencesTtlSeconds: 60,
  memorySize: 100,
  invalidationEnabled: false,
  defaultTtlSeconds: 60,
};
jest.mock("../../src/services/configService", () => ({
  config: { cache: cacheConfig },
}));

beforeEach(() => {
  jest.resetModules();
  ping.mockReset();
  cacheConfig.redisUrl = "";
});
test("local memory cache is ready", async () => {
  const { isRuntimeCacheReady } =
    await import("../../src/services/cacheService");
  expect(await isRuntimeCacheReady()).toBe(true);
  expect(ping).not.toHaveBeenCalled();
});
test.each([true, false])(
  "Redis dependency reports actual ping success %s",
  async (success) => {
    cacheConfig.redisUrl = "rediss://fixture.invalid:6379";
    if (success) ping.mockResolvedValue("PONG");
    else ping.mockRejectedValue(new Error("offline"));
    const { isRuntimeCacheReady } =
      await import("../../src/services/cacheService");
    expect(await isRuntimeCacheReady()).toBe(success);
  },
);
