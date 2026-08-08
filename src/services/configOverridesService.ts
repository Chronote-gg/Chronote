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
  const repository = getConfigOverridesRepository();
  // saveAutoRecordSetting rewrites the enabled value and any supplied channel
  // or tags on every save, so reopening a rule and saving it unchanged would
  // otherwise count as a settings change and inflate the totals. Mirrors the
  // existence check on the reset path below.
  const existing = await repository.get(scopeId, configKey);
  const unchanged =
    existing !== undefined &&
    JSON.stringify(existing.value) === JSON.stringify(value);
  const record: ConfigOverrideRecord = {
    scopeId,
    configKey,
    value,
    updatedAt: nowIso(),
    updatedBy: userId,
  };
  await repository.write(record);
  if (unchanged) return;

  // Setting a value and resetting to default are the two ways config changes,
  // and both flow through this pair: the settings UI, channel overrides, and
  // autorecord all use them. The key and scope describe what was configured;
  // the value is deliberately omitted because context prompts and note
  // templates are user content.
  captureEvent("setting_changed", {
    userId,
    guildId: context.guildId,
    properties: { key: configKey, scope: context.scope, action: "set" },
  });
}

export async function clearConfigOverrideForScope(
  context: ConfigOverrideScopeContext,
  configKey: string,
  userId?: string,
): Promise<void> {
  const scopeId = buildScopeId(context);
  const repository = getConfigOverridesRepository();
  // The removal is idempotent, and callers clear keys that were never set:
  // saveAutoRecordSetting clears the optional channel and tag keys on every
  // save, including for a channel being configured for the first time. Only an
  // override that actually existed is a reset worth reporting.
  const existing = await repository.get(scopeId, configKey);
  await repository.remove(scopeId, configKey);
  if (!existing) return;

  // Optional actor: callers that know who reset the value should pass it, and
  // the ones that do not still record that the reset happened, scoped to the
  // guild. Omitting resets entirely would make "setting_changed" read as if
  // every override were permanent.
  captureEvent("setting_changed", {
    userId,
    guildId: context.guildId,
    properties: { key: configKey, scope: context.scope, action: "reset" },
  });
}
