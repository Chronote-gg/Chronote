import type { Request, Response } from "express";
import { configRouter } from "../../src/trpc/routers/config";
import { CONFIG_KEYS } from "../../src/config/keys";
import { getConfigEntry } from "../../src/config/registry";
import { coerceConfigValue } from "../../src/config/validation";
import { resolveSpeechDetectionMode } from "../../src/config/speechDetection";
import { config } from "../../src/services/configService";
import { getMockUser } from "../../src/repositories/mockStore";
import { ensureManageGuildWithUserToken } from "../../src/services/guildAccessService";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(async () => true),
}));

const key = CONFIG_KEYS.transcription.speechDetectionMode;
const req = { session: {}, headers: {} } as Request;
const res = {} as Response;
const caller = () =>
  configRouter.createCaller({ req, res, user: getMockUser() });

it.each(["off", "shadow", "enforce"])(
  "validates mode %s through the schema and config registry",
  (mode) => {
    expect(resolveSpeechDetectionMode(mode)).toBe(mode);
    const entry = getConfigEntry(key);
    expect(entry).toBeDefined();
    if (!entry) throw Error("Missing registry entry");
    expect(coerceConfigValue(entry, mode)).toEqual({
      valid: true,
      value: mode,
    });
  },
);

it.each(["anything", "", null, undefined, 1, true])(
  "rejects arbitrary mode %s",
  (value) => {
    expect(() => resolveSpeechDetectionMode(value)).toThrow();
    const entry = getConfigEntry(key);
    if (!entry) throw Error("Missing registry entry");
    expect(coerceConfigValue(entry, value).valid).toBe(false);
  },
);

it("rejects server overrides at the real tRPC boundary", async () => {
  jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(true);
  await expect(
    caller().setServerOverride({ serverId: "guild-1", key, value: "enforce" }),
  ).rejects.toThrow("Config key is not server scoped.");
});

it("requires superadmin for global read and publication", async () => {
  const previous = config.admin.superAdminUserIds;
  config.admin.superAdminUserIds = [];
  try {
    await expect(caller().global()).rejects.toThrow(
      "Super admin access required.",
    );
    await expect(
      caller().publishGlobal({ values: { [key]: "enforce" } }),
    ).rejects.toThrow("Super admin access required.");
    config.admin.superAdminUserIds = [getMockUser().id];
    const global = await caller().global();
    expect(global.values).toContainEqual({
      key,
      value: "off",
      source: "default",
    });
    expect(global.registry.find((entry) => entry.key === key)).toMatchObject({
      group: "Experimental",
      scopes: {
        global: { enabled: true, role: "superadmin", control: "select" },
      },
    });
  } finally {
    config.admin.superAdminUserIds = previous;
  }
});
