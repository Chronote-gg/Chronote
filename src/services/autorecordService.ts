import { CONFIG_KEYS } from "../config/keys";
import type { AutoRecordSettings } from "../types/db";
import { nowIso } from "../utils/time";
import { parseTags } from "../utils/tags";
import {
  buildScopePrefix,
  clearConfigOverrideForScope,
  getConfigOverrideForScope,
  listConfigOverridesForScope,
  listConfigOverridesForScopePrefix,
  setConfigOverrideForScope,
} from "./configOverridesService";

const AUTO_RECORD_KEYS_SET = new Set<string>([
  CONFIG_KEYS.autorecord.enabled,
  CONFIG_KEYS.notes.channelId,
  CONFIG_KEYS.notes.tags,
]);
const coerceString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const coerceBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

const resolveLatestRecord = <T extends { updatedAt: string }>(records: T[]) =>
  records.reduce(
    (latest, record) =>
      !latest || record.updatedAt > latest.updatedAt ? record : latest,
    undefined as T | undefined,
  );

const buildSetting = (options: {
  guildId: string;
  channelId: string;
  recordAll: boolean;
  enabled: boolean;
  textChannelId?: string;
  tags?: string[];
  updatedAt?: string;
  updatedBy?: string;
}): AutoRecordSettings => ({
  guildId: options.guildId,
  channelId: options.channelId,
  textChannelId: options.textChannelId,
  enabled: options.enabled,
  recordAll: options.recordAll,
  createdAt: options.updatedAt ?? nowIso(),
  createdBy: options.updatedBy ?? "system",
  tags: options.tags,
});

const buildRecordMap = (records: { configKey: string; value: unknown }[]) =>
  new Map(records.map((record) => [record.configKey, record.value]));

const buildAutoRecordSettingFromRecords = (options: {
  guildId: string;
  channelId: string;
  recordAll: boolean;
  records: {
    configKey: string;
    value: unknown;
    updatedAt: string;
    updatedBy: string;
  }[];
}): AutoRecordSettings | undefined => {
  const map = buildRecordMap(options.records);
  const enabled = coerceBoolean(map.get(CONFIG_KEYS.autorecord.enabled));
  if (!enabled) return undefined;
  const textChannelId = coerceString(map.get(CONFIG_KEYS.notes.channelId));
  const tagsValue = map.get(CONFIG_KEYS.notes.tags);
  const tags = typeof tagsValue === "string" ? parseTags(tagsValue) : undefined;
  const relevant = options.records.filter((record) =>
    AUTO_RECORD_KEYS_SET.has(record.configKey),
  );
  const latest = resolveLatestRecord(relevant);
  return buildSetting({
    guildId: options.guildId,
    channelId: options.channelId,
    recordAll: options.recordAll,
    enabled,
    textChannelId,
    tags,
    updatedAt: latest?.updatedAt,
    updatedBy: latest?.updatedBy,
  });
};

export async function listAutoRecordSettings(guildId: string) {
  const settings: AutoRecordSettings[] = [];

  const serverOverrides = await listConfigOverridesForScope({
    scope: "server",
    guildId,
  });
  const serverSetting = buildAutoRecordSettingFromRecords({
    guildId,
    channelId: "ALL",
    recordAll: true,
    records: serverOverrides,
  });
  if (serverSetting) {
    settings.push(serverSetting);
  }

  const channelOverrides = await listConfigOverridesForScopePrefix(
    buildScopePrefix("channel", guildId),
  );
  const byChannel = new Map<string, typeof channelOverrides>();
  channelOverrides.forEach((record) => {
    const parts = record.scopeId.split("#");
    if (parts.length < 3) return;
    const channelId = parts.slice(2).join("#");
    const list = byChannel.get(channelId) ?? [];
    list.push(record);
    byChannel.set(channelId, list);
  });

  byChannel.forEach((records, channelId) => {
    const setting = buildAutoRecordSettingFromRecords({
      guildId,
      channelId,
      recordAll: false,
      records,
    });
    if (setting) settings.push(setting);
  });

  return settings;
}

export async function getAutoRecordSettingByChannel(
  guildId: string,
  channelId: string,
) {
  if (channelId === "ALL") {
    const serverOverrides = await listConfigOverridesForScope({
      scope: "server",
      guildId,
    });
    return buildAutoRecordSettingFromRecords({
      guildId,
      channelId: "ALL",
      recordAll: true,
      records: serverOverrides,
    });
  }

  const channelOverrides = await listConfigOverridesForScope({
    scope: "channel",
    guildId,
    channelId,
  });
  return buildAutoRecordSettingFromRecords({
    guildId,
    channelId,
    recordAll: false,
    records: channelOverrides,
  });
}

export async function saveAutoRecordSetting(params: {
  guildId: string;
  channelId: string;
  textChannelId?: string | null;
  enabled: boolean;
  recordAll: boolean;
  createdBy: string;
  tags?: string[];
}): Promise<AutoRecordSettings> {
  const recordAll = params.recordAll || params.channelId === "ALL";
  const scope = recordAll
    ? ({ scope: "server", guildId: params.guildId } as const)
    : ({
        scope: "channel",
        guildId: params.guildId,
        channelId: params.channelId,
      } as const);
  const preservesDestination = recordAll
    ? params.textChannelId == null
    : params.textChannelId === undefined;
  const textChannelId = preservesDestination
    ? coerceString(
        (await getConfigOverrideForScope(scope, CONFIG_KEYS.notes.channelId))
          ?.value,
      )
    : (params.textChannelId ?? undefined);

  await setConfigOverrideForScope(
    scope,
    CONFIG_KEYS.autorecord.enabled,
    params.enabled,
    params.createdBy,
  );
  if (params.textChannelId) {
    await setConfigOverrideForScope(
      scope,
      CONFIG_KEYS.notes.channelId,
      params.textChannelId,
      params.createdBy,
    );
  } else if (!recordAll && params.textChannelId === null) {
    await clearConfigOverrideForScope(scope, CONFIG_KEYS.notes.channelId);
  }
  if (params.tags) {
    await setConfigOverrideForScope(
      scope,
      CONFIG_KEYS.notes.tags,
      params.tags.join(", "),
      params.createdBy,
    );
  } else if (!recordAll) {
    await clearConfigOverrideForScope(scope, CONFIG_KEYS.notes.tags);
  }

  return buildSetting({
    guildId: params.guildId,
    channelId: recordAll ? "ALL" : params.channelId,
    recordAll,
    enabled: params.enabled,
    textChannelId,
    tags: params.tags,
  });
}
export async function removeAutoRecordSetting(
  guildId: string,
  channelId: string,
) {
  if (channelId === "ALL") {
    const scope = { scope: "server", guildId } as const;
    await setConfigOverrideForScope(
      scope,
      CONFIG_KEYS.autorecord.enabled,
      false,
      "system",
    );
    return;
  }

  const scope = { scope: "channel", guildId, channelId } as const;
  await Promise.all([
    clearConfigOverrideForScope(scope, CONFIG_KEYS.autorecord.enabled),
    clearConfigOverrideForScope(scope, CONFIG_KEYS.notes.tags),
  ]);
}
