import { CONFIG_KEYS } from "../config/keys";
import type { ChannelContext } from "../types/db";
import {
  buildScopePrefix,
  clearConfigOverrideForScope,
  listConfigOverridesForScope,
  listConfigOverridesForScopePrefix,
  setConfigOverrideForScope,
} from "./configOverridesService";

const CHANNEL_CONTEXT_KEYS = new Set<string>([
  CONFIG_KEYS.context.instructions,
  CONFIG_KEYS.notes.channelId,
  CONFIG_KEYS.liveVoice.enabled,
  CONFIG_KEYS.liveVoice.commandsEnabled,
  CONFIG_KEYS.chatTts.enabled,
  CONFIG_KEYS.chatTts.ttsOnlyEnabled,
]);
const CHANNEL_CONTEXT_CLEAR_KEYS = [CONFIG_KEYS.context.instructions];
const resolveLatestRecord = <T extends { updatedAt: string }>(records: T[]) =>
  records.reduce(
    (latest, record) =>
      !latest || record.updatedAt > latest.updatedAt ? record : latest,
    undefined as T | undefined,
  );

const coerceString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const coerceBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

const queueStringOverride = (
  tasks: Promise<void>[],
  scope: { scope: "channel"; guildId: string; channelId: string },
  key: string,
  value: string | null | undefined,
  userId: string,
) => {
  if (value === undefined) return;
  const trimmed = value?.trim() ?? "";
  tasks.push(
    trimmed
      ? setConfigOverrideForScope(scope, key, trimmed, userId)
      : clearConfigOverrideForScope(scope, key),
  );
};

const queueNullableOverride = <T>(
  tasks: Promise<void>[],
  scope: { scope: "channel"; guildId: string; channelId: string },
  key: string,
  value: T | null | undefined,
  userId: string,
) => {
  if (value === undefined) return;
  tasks.push(
    value === null
      ? clearConfigOverrideForScope(scope, key)
      : setConfigOverrideForScope(scope, key, value, userId),
  );
};

export type ChannelContextUpdate = {
  context?: string | null;
  defaultNotesChannelId?: string | null;
  liveVoiceEnabled?: boolean | null;
  liveVoiceCommandsEnabled?: boolean | null;
  chatTtsEnabled?: boolean | null;
  chatTtsTtsOnlyEnabled?: boolean | null;
};

export async function setChannelContext(
  guildId: string,
  channelId: string,
  userId: string,
  update: ChannelContextUpdate,
) {
  const scope = { scope: "channel", guildId, channelId } as const;
  const tasks: Promise<void>[] = [];

  queueStringOverride(
    tasks,
    scope,
    CONFIG_KEYS.context.instructions,
    update.context,
    userId,
  );
  queueStringOverride(
    tasks,
    scope,
    CONFIG_KEYS.notes.channelId,
    update.defaultNotesChannelId,
    userId,
  );
  queueNullableOverride(
    tasks,
    scope,
    CONFIG_KEYS.liveVoice.enabled,
    update.liveVoiceEnabled,
    userId,
  );
  queueNullableOverride(
    tasks,
    scope,
    CONFIG_KEYS.liveVoice.commandsEnabled,
    update.liveVoiceCommandsEnabled,
    userId,
  );
  queueNullableOverride(
    tasks,
    scope,
    CONFIG_KEYS.chatTts.enabled,
    update.chatTtsEnabled,
    userId,
  );
  queueNullableOverride(
    tasks,
    scope,
    CONFIG_KEYS.chatTts.ttsOnlyEnabled,
    update.chatTtsTtsOnlyEnabled,
    userId,
  );

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

export async function fetchChannelContext(guildId: string, channelId: string) {
  const overrides = await listConfigOverridesForScope({
    scope: "channel",
    guildId,
    channelId,
  });
  const relevant = overrides.filter((record) =>
    CHANNEL_CONTEXT_KEYS.has(record.configKey),
  );
  if (relevant.length === 0) return undefined;

  const latest = resolveLatestRecord(relevant);
  if (!latest) return undefined;

  const map = new Map(
    relevant.map((record) => [record.configKey, record.value]),
  );
  const context = coerceString(map.get(CONFIG_KEYS.context.instructions));
  const defaultNotesChannelId = coerceString(
    map.get(CONFIG_KEYS.notes.channelId),
  );
  const liveVoiceEnabled = coerceBoolean(
    map.get(CONFIG_KEYS.liveVoice.enabled),
  );
  const liveVoiceCommandsEnabled = coerceBoolean(
    map.get(CONFIG_KEYS.liveVoice.commandsEnabled),
  );
  const chatTtsEnabled = coerceBoolean(map.get(CONFIG_KEYS.chatTts.enabled));
  const chatTtsTtsOnlyEnabled = coerceBoolean(
    map.get(CONFIG_KEYS.chatTts.ttsOnlyEnabled),
  );

  const next: ChannelContext = {
    guildId,
    channelId,
    updatedAt: latest.updatedAt,
    updatedBy: latest.updatedBy,
  };

  if (context) {
    next.context = context;
  }
  if (defaultNotesChannelId) {
    next.defaultNotesChannelId = defaultNotesChannelId;
  }
  if (liveVoiceEnabled !== undefined) {
    next.liveVoiceEnabled = liveVoiceEnabled;
  }
  if (liveVoiceCommandsEnabled !== undefined) {
    next.liveVoiceCommandsEnabled = liveVoiceCommandsEnabled;
  }
  if (chatTtsEnabled !== undefined) {
    next.chatTtsEnabled = chatTtsEnabled;
  }
  if (chatTtsTtsOnlyEnabled !== undefined) {
    next.chatTtsTtsOnlyEnabled = chatTtsTtsOnlyEnabled;
  }

  return next;
}

export async function clearChannelContext(guildId: string, channelId: string) {
  const scope = { scope: "channel", guildId, channelId } as const;
  await Promise.all(
    CHANNEL_CONTEXT_CLEAR_KEYS.map((key) =>
      clearConfigOverrideForScope(scope, key),
    ),
  );
}

export async function clearChannelContextSettings(
  guildId: string,
  channelId: string,
) {
  const scope = { scope: "channel", guildId, channelId } as const;
  await Promise.all(
    Array.from(CHANNEL_CONTEXT_KEYS, (key) =>
      clearConfigOverrideForScope(scope, key),
    ),
  );
}

export async function listChannelContexts(guildId: string) {
  const overrides = await listConfigOverridesForScopePrefix(
    buildScopePrefix("channel", guildId),
  );
  const relevant = overrides.filter((record) =>
    CHANNEL_CONTEXT_KEYS.has(record.configKey),
  );
  if (relevant.length === 0) return [];

  const byChannel = new Map<string, typeof relevant>();
  relevant.forEach((record) => {
    const parts = record.scopeId.split("#");
    if (parts.length < 3) return;
    const channelId = parts.slice(2).join("#");
    const list = byChannel.get(channelId) ?? [];
    list.push(record);
    byChannel.set(channelId, list);
  });

  return Array.from(byChannel.entries()).flatMap(([channelId, records]) => {
    const latest = resolveLatestRecord(records);
    if (!latest) return [];
    const map = new Map(
      records.map((record) => [record.configKey, record.value]),
    );
    const context = coerceString(map.get(CONFIG_KEYS.context.instructions));
    const defaultNotesChannelId = coerceString(
      map.get(CONFIG_KEYS.notes.channelId),
    );
    const liveVoiceEnabled = coerceBoolean(
      map.get(CONFIG_KEYS.liveVoice.enabled),
    );
    const liveVoiceCommandsEnabled = coerceBoolean(
      map.get(CONFIG_KEYS.liveVoice.commandsEnabled),
    );
    const chatTtsEnabled = coerceBoolean(map.get(CONFIG_KEYS.chatTts.enabled));
    const chatTtsTtsOnlyEnabled = coerceBoolean(
      map.get(CONFIG_KEYS.chatTts.ttsOnlyEnabled),
    );

    const next: ChannelContext = {
      guildId,
      channelId,
      updatedAt: latest.updatedAt,
      updatedBy: latest.updatedBy,
    };

    if (context) {
      next.context = context;
    }
    if (defaultNotesChannelId) {
      next.defaultNotesChannelId = defaultNotesChannelId;
    }
    if (liveVoiceEnabled !== undefined) {
      next.liveVoiceEnabled = liveVoiceEnabled;
    }
    if (liveVoiceCommandsEnabled !== undefined) {
      next.liveVoiceCommandsEnabled = liveVoiceCommandsEnabled;
    }
    if (chatTtsEnabled !== undefined) {
      next.chatTtsEnabled = chatTtsEnabled;
    }
    if (chatTtsTtsOnlyEnabled !== undefined) {
      next.chatTtsTtsOnlyEnabled = chatTtsTtsOnlyEnabled;
    }

    return [next];
  });
}
