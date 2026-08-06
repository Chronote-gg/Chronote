import { getConfigOverridesRepository } from "../repositories/configOverridesRepository";
import type { ConfigOverrideRecord } from "../types/db";
import type { ConfigScope } from "../config/types";
import { nowIso } from "../utils/time";
import { captureEvent } from "./analyticsService";

export type ConfigOverrideScopeContext = {
  scope: ConfigScope;
  guildId?: string;
  channelId?: string;
  userId?: string;
  meetingId?: string;
};

export function buildScopeId(context: ConfigOverrideScopeContext): string {
  const { scope } = context;
  if (scope === "global") {
    throw new Error("Global overrides are not supported.");
  }
  if (scope === "server") {
    if (!context.guildId) {
      throw new Error("guildId is required for server scope.");
    }
    return `server#${context.guildId}`;
  }
  if (scope === "channel") {
    if (!context.guildId || !context.channelId) {
      throw new Error("guildId and channelId are required for channel scope.");
    }
    return `channel#${context.guildId}#${context.channelId}`;
  }
  if (scope === "user") {
    if (!context.guildId || !context.userId) {
      throw new Error("guildId and userId are required for user scope.");
    }
    return `user#${context.guildId}#${context.userId}`;
  }
  if (scope === "meeting") {
    if (!context.meetingId) {
      throw new Error("meetingId is required for meeting scope.");
    }
    return `meeting#${context.meetingId}`;
  }
  throw new Error(`Unsupported scope: ${scope}`);
}

export async function listConfigOverridesForScope(
  context: ConfigOverrideScopeContext,
): Promise<ConfigOverrideRecord[]> {
  const scopeId = buildScopeId(context);
  return getConfigOverridesRepository().listByScope(scopeId);
}

export async function listConfigOverridesForScopePrefix(
  scopePrefix: string,
): Promise<ConfigOverrideRecord[]> {
  return getConfigOverridesRepository().listByScopePrefix(scopePrefix);
}

export function buildScopePrefix(scope: "channel" | "user", guildId: string) {
  if (scope === "channel") {
    return `channel#${guildId}#`;
  }
  return `user#${guildId}#`;
}

export async function getConfigOverrideForScope(
  context: ConfigOverrideScopeContext,
  configKey: string,
): Promise<ConfigOverrideRecord | undefined> {
  const scopeId = buildScopeId(context);
  return getConfigOverridesRepository().get(scopeId, configKey);
}

export async function setConfigOverrideForScope(
  context: ConfigOverrideScopeContext,
  configKey: string,
  value: unknown,
  userId: string,
): Promise<void> {
  const scopeId = buildScopeId(context);
  const record: ConfigOverrideRecord = {
    scopeId,
    configKey,
    value,
    updatedAt: nowIso(),
    updatedBy: userId,
  };
  await getConfigOverridesRepository().write(record);

  // Every settings change routes through here: the settings UI, channel
  // overrides, and autorecord all write overrides, so this one call site
  // covers all three. The key and scope describe what was configured; the
  // value is deliberately omitted because context prompts and note templates
  // are user content.
  captureEvent("setting_changed", {
    userId,
    guildId: context.guildId,
    properties: { key: configKey, scope: context.scope },
  });
}

export async function clearConfigOverrideForScope(
  context: ConfigOverrideScopeContext,
  configKey: string,
): Promise<void> {
  const scopeId = buildScopeId(context);
  await getConfigOverridesRepository().remove(scopeId, configKey);
}
