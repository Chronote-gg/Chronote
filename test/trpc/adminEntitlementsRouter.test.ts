import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";

const envSnapshot = { ...process.env };

async function loadHarness(superAdminIds: string) {
  jest.resetModules();
  process.env = {
    ...envSnapshot,
    MOCK_MODE: "true",
    SUPER_ADMIN_USER_IDS: superAdminIds,
  };
  const [{ appRouter }, { resetMockStore }, { getEntitlementGrantRepository }] =
    await Promise.all([
      import("../../src/trpc/router"),
      import("../../src/repositories/mockStore"),
      import("../../src/repositories/entitlementGrantRepository"),
    ]);
  resetMockStore();
  const buildCaller = (userId: string) =>
    appRouter.createCaller({
      req: { session: {} } as Request,
      res: {} as Response,
      user: {
        id: userId,
        username: "Tester",
        discriminator: "0001",
        avatar: null,
        accessToken: "token",
      } as never,
    });
  return { buildCaller, getEntitlementGrantRepository };
}

describe("adminEntitlements router", () => {
  afterEach(() => {
    process.env = { ...envSnapshot };
    jest.resetModules();
  });

  it("blocks non-superadmins", async () => {
    const { buildCaller } = await loadHarness("admin-1");
    await expect(
      buildCaller("user-1").adminEntitlements.list({ limit: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets superadmins create direct guild grants", async () => {
    const { buildCaller, getEntitlementGrantRepository } =
      await loadHarness("admin-1");
    const result = await buildCaller("admin-1").adminEntitlements.create({
      guildId: "222222222222222222",
      tier: "pro",
      label: "Prospect demo",
      expiresAt: null,
    });

    expect(result.grant.tier).toBe("pro");
    expect(result.grant.expiresAt).toBeUndefined();
    await expect(
      getEntitlementGrantRepository().get(result.grant.grantId),
    ).resolves.toMatchObject({
      guildId: "222222222222222222",
      label: "Prospect demo",
      status: "active",
    });
  });
});
