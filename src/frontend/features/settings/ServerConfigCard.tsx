import { useAuthNavigationBlocker } from "../../hooks/useAuthNavigationBlocker";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Accordion,
  Button,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconAlertTriangle, IconSettings } from "@tabler/icons-react";
import Surface from "../../components/Surface";
import {
  ConfigValueField,
  type ConfigUiContext,
} from "../../components/ConfigValueField";
import type { ConfigEntryInput } from "../../types/configEntry";
import type {
  ConfigOverrideInput,
  ResolvedConfigSnapshotInput,
} from "../../types/configSnapshot";
import { uiOverlays } from "../../uiTokens";
import type { ConfigTier } from "../../../config/types";
import { CONFIG_KEYS } from "../../../config/keys";
import { resolveScopeConfigInput } from "../../utils/configScopes";
import {
  CONFIG_GROUP_ORDER,
  PRIMARY_CONFIG_GROUPS,
  resolveConfigGroup,
} from "../../../config/grouping";

type ConfigDraftEntry = {
  mode: "inherit" | "override";
  value: unknown;
};

type ServerConfigCardProps = {
  busy: boolean;
  registry: ConfigEntryInput[];
  snapshot?: ResolvedConfigSnapshotInput;
  overrides: ConfigOverrideInput[];
  onSet: (key: string, value: unknown) => Promise<void>;
  onClear: (key: string) => Promise<void>;
  onSaved?: () => void;
  uiContext?: ConfigUiContext;
};

const TIER_ORDER: Record<ConfigTier, number> = {
  free: 0,
  basic: 1,
  pro: 2,
};

const SOURCE_LABELS: Record<string, string> = {
  appconfig: "Global default",
  default: "Default",
  experimental: "Experimental",
  server: "Server",
  channel: "Channel",
  user: "User",
  meeting: "Meeting",
  gated: "Gated",
};

const formatSourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

const isTierAllowed = (tier: ConfigTier | undefined, minTier?: ConfigTier) => {
  if (!minTier) return true;
  const currentRank = TIER_ORDER[tier ?? "free"] ?? 0;
  return currentRank >= TIER_ORDER[minTier];
};

const resolveResolvedValue = (
  snapshot: ResolvedConfigSnapshotInput | undefined,
  entry: ConfigEntryInput,
) => snapshot?.values[entry.key]?.value;

const resolveSuggestedValue = (
  entry: ConfigEntryInput,
  resolvedValue: unknown,
) => {
  if (resolvedValue !== undefined && resolvedValue !== null) {
    return resolvedValue;
  }
  return entry.defaultValue ?? resolvedValue;
};

const resolveEntryMode = (
  entry: ConfigEntryInput,
  scopeConfig: ReturnType<typeof resolveScopeConfigInput>,
  resolvedValue: unknown,
): ConfigDraftEntry["mode"] => {
  if (!scopeConfig.required) return "inherit";
  if (resolvedValue !== undefined && resolvedValue !== null) return "inherit";
  if (entry.defaultValue !== undefined) return "inherit";
  return "override";
};

const resolveEntryDraft = (
  entry: ConfigEntryInput,
  scopeConfig: ReturnType<typeof resolveScopeConfigInput>,
  draft: Record<string, ConfigDraftEntry>,
  snapshot?: ResolvedConfigSnapshotInput,
): ConfigDraftEntry => {
  const existing = draft[entry.key];
  if (existing) return existing;
  const resolvedValue = resolveResolvedValue(snapshot, entry);
  return {
    mode: resolveEntryMode(entry, scopeConfig, resolvedValue),
    value: resolveSuggestedValue(entry, resolvedValue),
  };
};

const toGroupTestId = (group: string) =>
  `settings-config-group-${group.toLowerCase().replace(/\s+/g, "-")}`;

const formatTierLabel = (tier?: ConfigTier) =>
  tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "Required";

const formatInheritedStatus = (source: string, value: unknown) => {
  if (value === "") return "Status: Default (empty)";
  if (value === undefined || value === null) return "Status: Needs value";
  if (source === "appconfig") return "Status: Default (global)";
  if (source === "default") return "Status: Default";
  if (source === "experimental") return "Status: Experimental default";
  if (source === "gated") return "Status: Locked";
  return `Status: Inherited from ${formatSourceLabel(source)}`;
};

export function ServerConfigCard({
  busy,
  registry,
  snapshot,
  overrides,
  onSet,
  onClear,
  onSaved,
  uiContext: uiContextProp,
}: ServerConfigCardProps) {
  const serverEntries = useMemo(
    () =>
      registry.filter(
        (entry) => resolveScopeConfigInput(entry, "server").enabled,
      ),
    [registry],
  );
  const overridesMap = useMemo(() => {
    const map = new Map<string, unknown>();
    overrides.forEach((override) => {
      map.set(override.configKey, override.value);
    });
    return map;
  }, [overrides]);

  const [draft, setDraft] = useState<Record<string, ConfigDraftEntry>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useAuthNavigationBlocker(dirty);
  useAuthNavigationBlocker(saving);

  useEffect(() => {
    if (dirty || !snapshot) return;
    const nextDraft: Record<string, ConfigDraftEntry> = {};
    serverEntries.forEach((entry) => {
      const scopeConfig = resolveScopeConfigInput(entry, "server");
      if (overridesMap.has(entry.key)) {
        nextDraft[entry.key] = {
          mode: "override",
          value: overridesMap.get(entry.key),
        };
        return;
      }
      const resolvedValue = resolveResolvedValue(snapshot, entry);
      const value = resolveSuggestedValue(entry, resolvedValue);
      nextDraft[entry.key] = {
        mode: resolveEntryMode(entry, scopeConfig, resolvedValue),
        value,
      };
    });
    setDraft(nextDraft);
    setDirty(false);
  }, [dirty, overridesMap, serverEntries, snapshot]);

  const experimentalEntry = draft[CONFIG_KEYS.features.experimental];
  const experimentalEnabled =
    experimentalEntry?.mode === "override"
      ? Boolean(experimentalEntry.value)
      : Boolean(
          snapshot?.values[CONFIG_KEYS.features.experimental]?.value ?? false,
        );

  const missingRequiredEntries = serverEntries.filter((entry) => {
    const scopeConfig = resolveScopeConfigInput(entry, "server");
    if (!scopeConfig.required) return false;
    const entryDraft = draft[entry.key];
    const value = entryDraft?.value ?? resolveResolvedValue(snapshot, entry);
    const hasValue = value !== undefined && value !== null;
    if (hasValue) return false;
    return entry.defaultValue === undefined;
  });

  const resolveDraftValue = (key: string) => {
    const entryDraft = draft[key];
    if (entryDraft) return entryDraft.value;
    return snapshot?.values[key]?.value;
  };
  const recordAllEnabled = Boolean(
    resolveDraftValue(CONFIG_KEYS.autorecord.enabled),
  );
  const notesChannelValue = resolveDraftValue(CONFIG_KEYS.notes.channelId);
  const notesChannelText =
    typeof notesChannelValue === "string" ? notesChannelValue.trim() : "";
  const recordAllNeedsNotesChannel =
    recordAllEnabled && notesChannelText.length === 0;

  const attentionEntries = useMemo(() => {
    if (!recordAllNeedsNotesChannel) return missingRequiredEntries;
    const notesEntry = serverEntries.find(
      (entry) => entry.key === CONFIG_KEYS.notes.channelId,
    );
    if (!notesEntry) return missingRequiredEntries;
    if (missingRequiredEntries.some((entry) => entry.key === notesEntry.key)) {
      return missingRequiredEntries;
    }
    return [...missingRequiredEntries, notesEntry];
  }, [missingRequiredEntries, recordAllNeedsNotesChannel, serverEntries]);

  const hasMissingRequired = attentionEntries.length > 0;

  const missingRequiredKeys = useMemo(
    () => new Set(attentionEntries.map((entry) => entry.key)),
    [attentionEntries],
  );

  const resolvedValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    if (snapshot?.values) {
      Object.entries(snapshot.values).forEach(([key, entry]) => {
        values[key] = entry.value;
      });
    }
    serverEntries.forEach((entry) => {
      const scopeConfig = resolveScopeConfigInput(entry, "server");
      const entryDraft = resolveEntryDraft(entry, scopeConfig, draft, snapshot);
      if (entryDraft.mode === "override") {
        values[entry.key] = entryDraft.value;
        return;
      }
      const resolvedValue = resolveResolvedValue(snapshot, entry);
      values[entry.key] = resolveSuggestedValue(entry, resolvedValue);
    });
    return values;
  }, [draft, serverEntries, snapshot]);

  const uiContext = useMemo(
    () => ({
      ...(uiContextProp ?? {}),
      resolvedValues,
      showLimitSources: false,
    }),
    [resolvedValues, uiContextProp],
  );

  const groupedEntries = useMemo(() => {
    const map = new Map<string, Map<string, ConfigEntryInput[]>>();
    serverEntries.forEach((entry) => {
      if (missingRequiredKeys.has(entry.key)) return;
      const group = resolveConfigGroup(entry);
      const category = entry.category || "General";
      if (!map.has(group)) {
        map.set(group, new Map());
      }
      const groupMap = map.get(group)!;
      if (!groupMap.has(category)) {
        groupMap.set(category, []);
      }
      groupMap.get(category)!.push(entry);
    });
    return map;
  }, [missingRequiredKeys, serverEntries]);
  const orderedGroups = [
    ...CONFIG_GROUP_ORDER.filter((group) => groupedEntries.has(group)),
    ...Array.from(groupedEntries.keys()).filter(
      (group) => !CONFIG_GROUP_ORDER.some((candidate) => candidate === group),
    ),
  ];
  const primaryGroups = orderedGroups.filter((group) =>
    PRIMARY_CONFIG_GROUPS.some((candidate) => candidate === group),
  );
  const secondaryGroups = orderedGroups.filter(
    (group) => !primaryGroups.includes(group),
  );
  const saveDisabled =
    busy || saving || hasMissingRequired || recordAllNeedsNotesChannel;

  const handleSave = async () => {
    if (busy || saving) return;
    const tasks: Promise<void>[] = [];
    serverEntries.forEach((entry) => {
      const entryDraft = draft[entry.key];
      if (!entryDraft) return;
      const hasOverride = overridesMap.has(entry.key);
      if (entryDraft.mode === "override") {
        const nextValue = entryDraft.value;
        if (!hasOverride || overridesMap.get(entry.key) !== nextValue) {
          tasks.push(onSet(entry.key, nextValue));
        }
      } else if (hasOverride) {
        tasks.push(onClear(entry.key));
      }
    });
    if (tasks.length === 0) {
      setDirty(false);
      return;
    }
    try {
      setSaving(true);
      await Promise.all(tasks);
      onSaved?.();
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!snapshot) return;
    const nextDraft: Record<string, ConfigDraftEntry> = {};
    serverEntries.forEach((entry) => {
      const scopeConfig = resolveScopeConfigInput(entry, "server");
      const resolvedValue = resolveResolvedValue(snapshot, entry);
      nextDraft[entry.key] = {
        mode: resolveEntryMode(entry, scopeConfig, resolvedValue),
        value: resolveSuggestedValue(entry, resolvedValue),
      };
    });
    const hasChanges = serverEntries.some((entry) => {
      const current = draft[entry.key];
      const next = nextDraft[entry.key];
      if (!current || !next) return true;
      return current.mode !== next.mode || current.value !== next.value;
    });
    setDraft(nextDraft);
    setDirty(hasChanges);
  };

  const handleValueChange = (entry: ConfigEntryInput, nextValue: unknown) => {
    setDraft((prev) => ({
      ...prev,
      [entry.key]: {
        mode: "override",
        value: nextValue,
      },
    }));
    setDirty(true);
  };

  const handleOverrideIntent = (
    entry: ConfigEntryInput,
    intentValue?: unknown,
  ) => {
    const scopeConfig = resolveScopeConfigInput(entry, "server");
    setDraft((prev) => {
      const existing =
        prev[entry.key] ??
        resolveEntryDraft(entry, scopeConfig, prev, snapshot);
      if (
        existing.mode === "override" &&
        (intentValue === undefined || existing.value === intentValue)
      ) {
        return prev;
      }
      return {
        ...prev,
        [entry.key]: {
          mode: "override",
          value: intentValue !== undefined ? intentValue : existing.value,
        },
      };
    });
    setDirty(true);
  };

  const handleResetEntry = (entry: ConfigEntryInput) => {
    if (!snapshot) return;
    const scopeConfig = resolveScopeConfigInput(entry, "server");
    const resolvedValue = resolveResolvedValue(snapshot, entry);
    const value = resolveSuggestedValue(entry, resolvedValue);
    setDraft((prev) => ({
      ...prev,
      [entry.key]: {
        mode: resolveEntryMode(entry, scopeConfig, resolvedValue),
        value,
      },
    }));
    setDirty(true);
  };

  const EntryHeader = ({
    entry,
    requiredLabel,
    statusLabel,
  }: {
    entry: ConfigEntryInput;
    requiredLabel?: string;
    statusLabel: string;
  }) => (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Stack gap={2} style={{ flex: 1 }}>
        <Text fw={600}>{entry.label}</Text>
        <Text size="sm" c="dimmed">
          {entry.description}
        </Text>
      </Stack>
      <Stack gap={2} align="flex-end">
        <Text size="xs" c="dimmed">
          {statusLabel}
        </Text>
        {requiredLabel ? (
          <Text size="xs" c="dimmed">
            {requiredLabel}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );

  const EntryActions = ({
    entry,
    entryTestId,
    canReset,
  }: {
    entry: ConfigEntryInput;
    entryTestId: string;
    canReset: boolean;
  }) => {
    if (!canReset) return null;
    return (
      <Group justify="flex-end" gap="xs">
        <Button
          size="xs"
          variant="subtle"
          onClick={() => handleResetEntry(entry)}
          data-testid={`${entryTestId}-reset`}
        >
          Reset
        </Button>
      </Group>
    );
  };

  const resolveGateMessage = (
    entry: ConfigEntryInput,
    tier: ConfigTier | undefined,
    experimentalEnabled: boolean,
  ) => {
    const needsTier = !isTierAllowed(tier, entry.minTier);
    const needsExperimental = Boolean(
      entry.requiresExperimentalTag && !experimentalEnabled,
    );
    if (needsTier && needsExperimental) {
      return `Locked until you enable experimental features or upgrade to ${entry.minTier} tier.`;
    }
    if (needsTier) {
      return `Locked until you upgrade to ${entry.minTier} tier.`;
    }
    if (needsExperimental) {
      return "Locked until experimental features are enabled for this server.";
    }
    return "";
  };

  const EntryGateAlert = ({
    entry,
    tier,
    experimentalEnabled,
  }: {
    entry: ConfigEntryInput;
    tier: ConfigTier | undefined;
    experimentalEnabled: boolean;
  }) => {
    const message = resolveGateMessage(entry, tier, experimentalEnabled);
    if (!message) return null;
    return (
      <Alert
        icon={<IconAlertTriangle size={16} />}
        color="yellow"
        variant="light"
      >
        {message}
      </Alert>
    );
  };

  const renderEntry = (entry: ConfigEntryInput, group?: string) => {
    const scopeConfig = resolveScopeConfigInput(entry, "server");
    const entryDraft = resolveEntryDraft(entry, scopeConfig, draft, snapshot);
    const resolved = snapshot?.values[entry.key];
    const resolvedSource = resolved?.source ?? "appconfig";
    const resolvedValue = resolved?.value;
    const isExperimentalGroup = group === "Experimental";
    const isExperimentalToggle =
      entry.key === CONFIG_KEYS.features.experimental;
    const isTierLocked = !isTierAllowed(snapshot?.tier, entry.minTier);
    const isExperimentalLocked =
      Boolean(entry.requiresExperimentalTag) && !experimentalEnabled;
    const isLocked = isExperimentalGroup
      ? !isExperimentalToggle && (isExperimentalLocked || isTierLocked)
      : isExperimentalLocked || isTierLocked;
    const isOverridden = entryDraft.mode === "override";
    const showLockedStatus = !isExperimentalGroup && isLocked;
    const fallbackSource =
      !showLockedStatus && resolvedSource === "gated"
        ? "appconfig"
        : resolvedSource;
    const statusLabel = isOverridden
      ? "Status: Overridden"
      : showLockedStatus
        ? "Status: Locked"
        : formatInheritedStatus(fallbackSource, resolvedValue);
    const entryTestId = `settings-config-entry-${entry.key}`;
    const isMissingRequired = missingRequiredKeys.has(entry.key);
    const notesRequired =
      recordAllNeedsNotesChannel && entry.key === CONFIG_KEYS.notes.channelId;
    const requiredLabel = notesRequired
      ? "Required for record-all"
      : isMissingRequired
        ? "Required"
        : undefined;
    const valueDisabled = busy || saving || isLocked;
    const canReset =
      isOverridden && snapshot !== undefined && !isMissingRequired;
    const tone = isOverridden ? "default" : "soft";

    return (
      <Surface key={entry.key} tone={tone} p="md" data-testid={entryTestId}>
        <Stack gap="sm">
          <EntryHeader
            entry={entry}
            requiredLabel={requiredLabel}
            statusLabel={statusLabel}
          />

          <EntryActions
            entry={entry}
            entryTestId={entryTestId}
            canReset={canReset}
          />

          <ConfigValueField
            entry={entry}
            value={entryDraft.value}
            onChange={(nextValue) => handleValueChange(entry, nextValue)}
            onOverrideIntent={(nextValue) =>
              handleOverrideIntent(entry, nextValue)
            }
            disabled={valueDisabled}
            uiContext={uiContext}
          />

          {showLockedStatus ? (
            <EntryGateAlert
              entry={entry}
              tier={snapshot?.tier}
              experimentalEnabled={experimentalEnabled}
            />
          ) : null}
        </Stack>
      </Surface>
    );
  };

  const renderGroupSections = (
    group: string,
    groupEntries: Map<string, ConfigEntryInput[]>,
  ) => {
    const isExperimentalGroup = group === "Experimental";
    const flattenedEntries = Array.from(groupEntries.values()).flat();
    const gatedEntries = flattenedEntries.filter(
      (entry) => entry.key !== CONFIG_KEYS.features.experimental,
    );
    const needsExperimental =
      isExperimentalGroup &&
      !experimentalEnabled &&
      gatedEntries.some((entry) => entry.requiresExperimentalTag);
    const maxTier = gatedEntries.reduce<ConfigTier | undefined>(
      (acc, entry) => {
        if (!entry.minTier) return acc;
        if (!acc) return entry.minTier;
        return TIER_ORDER[entry.minTier] > TIER_ORDER[acc]
          ? entry.minTier
          : acc;
      },
      undefined,
    );
    const needsTier =
      isExperimentalGroup &&
      gatedEntries.some(
        (entry) => !isTierAllowed(snapshot?.tier, entry.minTier),
      );
    let gateMessage: string | null = null;
    if (needsExperimental && needsTier) {
      gateMessage = `Enable experimental features or upgrade to ${formatTierLabel(
        maxTier,
      )} to edit these settings.`;
    } else if (needsExperimental) {
      gateMessage = "Enable experimental features to edit these settings.";
    } else if (needsTier) {
      gateMessage = `Upgrade to ${formatTierLabel(
        maxTier,
      )} to edit these settings.`;
    }

    let gateInserted = false;

    return (
      <Stack gap="sm" data-testid={toGroupTestId(group)}>
        {Array.from(groupEntries.entries()).map(
          ([category, categoryEntries]) => (
            <Stack key={`${group}-${category}`} gap="sm">
              <Text fw={600}>{category}</Text>
              {categoryEntries.map((entry) => {
                const entryNode = renderEntry(entry, group);
                const shouldInsertGate =
                  isExperimentalGroup &&
                  gateMessage &&
                  !gateInserted &&
                  entry.key === CONFIG_KEYS.features.experimental;
                if (shouldInsertGate) {
                  gateInserted = true;
                  return (
                    <Stack key={entry.key} gap="sm">
                      {entryNode}
                      <Alert
                        icon={<IconAlertTriangle size={16} />}
                        color="yellow"
                        variant="light"
                      >
                        {gateMessage}
                      </Alert>
                    </Stack>
                  );
                }
                return <Stack key={entry.key}>{entryNode}</Stack>;
              })}
            </Stack>
          ),
        )}
        {!gateInserted && gateMessage ? (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="yellow"
            variant="light"
          >
            {gateMessage}
          </Alert>
        ) : null}
      </Stack>
    );
  };

  if (serverEntries.length === 0) {
    return (
      <Surface tone="soft" p="md">
        <Text c="dimmed">No server configuration entries available.</Text>
      </Surface>
    );
  }

  return (
    <Surface
      p="lg"
      style={{ position: "relative", overflow: "hidden" }}
      data-testid="settings-config"
    >
      <LoadingOverlay
        visible={busy || saving}
        data-testid="settings-loading-config"
        overlayProps={uiOverlays.loading}
        loaderProps={{ size: "md" }}
      />
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap="sm">
            <ThemeIcon variant="light" color="brand">
              <IconSettings size={18} />
            </ThemeIcon>
            <Text fw={600}>Server configuration</Text>
          </Group>
          <Button
            variant="light"
            onClick={handleSave}
            disabled={saveDisabled}
            data-testid="settings-save-config"
          >
            Save settings
          </Button>
        </Group>

        <Stack gap="sm">
          {hasMissingRequired ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="red"
              variant="light"
            >
              Required settings need values before you can save.
            </Alert>
          ) : null}
          {recordAllNeedsNotesChannel ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="yellow"
              variant="light"
            >
              Record-all requires a default notes channel. Set one before saving
              or disable auto-record.
            </Alert>
          ) : null}

          {attentionEntries.length > 0 ? (
            <Stack gap="sm">
              <Text fw={600}>Needs attention</Text>
              {attentionEntries.map((entry) =>
                renderEntry(entry, resolveConfigGroup(entry)),
              )}
            </Stack>
          ) : null}

          {primaryGroups.map((group) => {
            const groupEntries = groupedEntries.get(group);
            if (!groupEntries) return null;
            return (
              <Stack key={group} gap="sm">
                <Text fw={600}>{group}</Text>
                {renderGroupSections(group, groupEntries)}
              </Stack>
            );
          })}

          {secondaryGroups.length > 0 ? (
            <Accordion multiple variant="contained">
              {secondaryGroups.map((group) => {
                const groupEntries = groupedEntries.get(group);
                if (!groupEntries) return null;
                return (
                  <Accordion.Item key={group} value={group}>
                    <Accordion.Control>{group}</Accordion.Control>
                    <Accordion.Panel>
                      {renderGroupSections(group, groupEntries)}
                    </Accordion.Panel>
                  </Accordion.Item>
                );
              })}
            </Accordion>
          ) : null}
        </Stack>

        <Group justify="space-between">
          <Button
            variant="subtle"
            onClick={handleReset}
            disabled={busy || saving || !snapshot}
          >
            Reset to defaults
          </Button>
          <Button variant="light" onClick={handleSave} disabled={saveDisabled}>
            Save settings
          </Button>
        </Group>
      </Stack>
    </Surface>
  );
}
