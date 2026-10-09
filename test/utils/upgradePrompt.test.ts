import { describe, expect, jest, test } from "@jest/globals";

const loadModule = async (billingLandingUrl: string) => {
  jest.resetModules();
  jest.doMock("../../src/services/configService", () => ({
    config: { stripe: { billingLandingUrl } },
  }));
  return await import("../../src/utils/upgradePrompt");
};

describe("upgrade prompt helpers", () => {
  test("buildUpgradePrompt includes button when billing URL is set", async () => {
    const { buildUpgradePrompt } = await loadModule("https://example.com/bill");
    const reply = buildUpgradePrompt("Upgrade now");
    expect(reply.components).toHaveLength(1);
    expect(reply.ephemeral).toBe(true);
    expect(JSON.stringify(reply.components)).toContain("source=discord_limit");
  });

  test("buildUpgradePrompt returns no components when billing URL is empty", async () => {
    const { buildUpgradePrompt } = await loadModule("");
    const reply = buildUpgradePrompt("Upgrade now");
    expect(reply.components).toHaveLength(0);
  });

  test("buildUpgradeTextOnly appends link when present", async () => {
    const { buildUpgradeTextOnly } = await loadModule(
      "https://example.com/bill",
    );
    expect(buildUpgradeTextOnly("Upgrade now")).toBe(
      "Upgrade now\nUpgrade: https://example.com/bill",
    );
  });

  test("tags Discord limit notices while preserving existing URL intent", async () => {
    const { buildUpgradeTextOnly } = await loadModule(
      "https://example.com/upgrade?promo=SAVE20#plans",
    );
    expect(buildUpgradeTextOnly("Limit reached", "discord_limit")).toBe(
      "Limit reached\nUpgrade: https://example.com/upgrade?promo=SAVE20&source=discord_limit#plans",
    );
  });
});
