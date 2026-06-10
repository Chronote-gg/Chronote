import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useGuildContext } from "../contexts/GuildContext";
import PageHeader from "../components/PageHeader";
import FormSelect from "../components/FormSelect";
import Surface from "../components/Surface";
import { trpc } from "../services/trpc";
import { buildApiUrl } from "../services/apiClient";
import { uiOverlays } from "../uiTokens";
import { parseTags } from "../../utils/tags";
import { TTS_VOICE_OPTIONS } from "../../utils/ttsVoices";
import { CONFIG_KEYS } from "../../config/keys";
import {
  DEFAULT_DICTIONARY_BUDGETS,
  resolveDictionaryBudgets,
} from "../../utils/dictionary";

import {
  buildChannelOverrides,
  formatChannelLabel,
  type ChannelOption,
  type ChannelOverride,
} from "../utils/settingsChannels";
import { ChannelOverridesCard } from "../features/settings/ChannelOverridesCard";
import { ServerConfigCard } from "../features/settings/ServerConfigCard";
import { DictionaryCard } from "../features/settings/DictionaryCard";
import { NotionIntegrationCard } from "../features/settings/NotionIntegrationCard";

type OverrideMode = "inherit" | "on" | "off";

const overrideModeFromBoolean = (value: boolean | undefined): OverrideMode =>
  value === undefined ? "inherit" : value ? "on" : "off";

const SettingsLoadingState = () => (
  <Stack gap="xl" data-testid="settings-page-loading">
    <PageHeader
      title="Server settings"
      description="Configure how Chronote records, tags, and summarizes this server."
    />
    <Surface p="xl">
      <Center py="xl">
        <Stack gap="xs" align="center">
          <Loader color="brand" />
          <Text c="dimmed">Loading server settings...</Text>
        </Stack>
      </Center>
    </Surface>
  </Stack>
);

export default function Settings() {
  const { selectedGuildId, loading: guildLoading } = useGuildContext();
  const trpcUtils = trpc.useUtils();
  const rulesQuery = trpc.autorecord.list.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const channelsQuery = trpc.servers.channels.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const configQuery = trpc.config.server.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const channelContextsQuery = trpc.channelContexts.list.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const dictionaryQuery = trpc.dictionary.list.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const notionStatusQuery = trpc.notion.automationStatus.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) && !guildLoading },
  );
  const [notionDestinationSearch, setNotionDestinationSearch] = useState<
    string | null
  >(null);
  const notionDestinationQuery = trpc.notion.destinationPages.useQuery(
    { serverId: selectedGuildId ?? "", query: notionDestinationSearch ?? "" },
    {
      enabled:
        Boolean(selectedGuildId) &&
        !guildLoading &&
        notionDestinationSearch !== null,
    },
  );

  const addRuleMutation = trpc.autorecord.add.useMutation();
  const removeRuleMutation = trpc.autorecord.remove.useMutation();
  const setServerConfigMutation = trpc.config.setServerOverride.useMutation();
  const clearServerConfigMutation =
    trpc.config.clearServerOverride.useMutation();
  const setChannelContextMutation = trpc.channelContexts.set.useMutation();
  const clearChannelContextMutation = trpc.channelContexts.clear.useMutation();
  const dictionaryUpsertMutation = trpc.dictionary.upsert.useMutation();
  const dictionaryRemoveMutation = trpc.dictionary.remove.useMutation();
  const dictionaryClearMutation = trpc.dictionary.clear.useMutation();
  const saveNotionAutomationMutation =
    trpc.notion.saveAutomationConfig.useMutation();
  const disableNotionAutomationMutation =
    trpc.notion.disableAutomation.useMutation();

  const [channelModalOpen, channelModal] = useDisclosure(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [channelVoiceChannelId, setChannelVoiceChannelId] = useState<
    string | null
  >(null);
  const [channelAutoRecord, setChannelAutoRecord] = useState(true);
  const [channelTextChannelId, setChannelTextChannelId] = useState<
    string | null
  >(null);
  const [channelTags, setChannelTags] = useState("");
  const [channelContext, setChannelContext] = useState("");
  const [channelLiveVoiceMode, setChannelLiveVoiceMode] = useState<
    "inherit" | "on" | "off"
  >("inherit");
  const [channelLiveVoiceCommandsMode, setChannelLiveVoiceCommandsMode] =
    useState<"inherit" | "on" | "off">("inherit");
  const [channelChatTtsMode, setChannelChatTtsMode] = useState<
    "inherit" | "on" | "off"
  >("inherit");
  const [channelChatTtsTtsOnlyMode, setChannelChatTtsTtsOnlyMode] = useState<
    "inherit" | "on" | "off"
  >("inherit");

  useEffect(() => {
    setEditingChannelId(null);
    setChannelVoiceChannelId(null);
    setChannelAutoRecord(true);
    setChannelTextChannelId(null);
    setChannelTags("");
    setChannelContext("");
    setChannelLiveVoiceMode("inherit");
    setChannelLiveVoiceCommandsMode("inherit");
    setChannelChatTtsMode("inherit");
    setChannelChatTtsTtsOnlyMode("inherit");
    channelModal.close();
  }, [selectedGuildId]);

  useEffect(() => {
    if (!channelModalOpen || editingChannelId) return;
    if (channelTags) return;
    setChannelTags("");
  }, [channelModalOpen, editingChannelId, channelTags]);

  const autoRecordRules = rulesQuery.data?.rules ?? [];
  const recordAllRule = autoRecordRules.find((rule) => rule.recordAll) ?? null;
  const channelRules = autoRecordRules.filter((rule) => !rule.recordAll);
  const channelContexts = channelContextsQuery.data?.contexts ?? [];
  const recordAllEnabled = Boolean(recordAllRule);
  const serverNotesChannelValue =
    configQuery.data?.snapshot?.values[CONFIG_KEYS.notes.channelId]?.value;
  const serverChatTtsEnabled = Boolean(
    configQuery.data?.snapshot?.values[CONFIG_KEYS.chatTts.enabled]?.value,
  );
  const serverTtsOnlyValue =
    configQuery.data?.snapshot?.values[CONFIG_KEYS.chatTts.ttsOnlyEnabled]
      ?.value;
  const serverTtsOnlyEnabled =
    serverTtsOnlyValue === undefined ? true : Boolean(serverTtsOnlyValue);
  const serverNotesChannelId =
    typeof serverNotesChannelValue === "string" &&
    serverNotesChannelValue.trim().length > 0
      ? serverNotesChannelValue
      : null;
  const defaultNotesChannelId =
    serverNotesChannelId ?? recordAllRule?.textChannelId ?? null;

  const voiceChannels = useMemo<ChannelOption[]>(
    () =>
      (channelsQuery.data?.voiceChannels ?? []).map((channel) => ({
        value: channel.id,
        label: channel.name,
        botAccess: channel.botAccess,
        missingPermissions: channel.missingPermissions ?? [],
      })),
    [channelsQuery.data],
  );
  const textChannels = useMemo<ChannelOption[]>(
    () =>
      (channelsQuery.data?.textChannels ?? []).map((channel) => ({
        value: channel.id,
        label: channel.name.startsWith("#") ? channel.name : `#${channel.name}`,
        botAccess: channel.botAccess,
        missingPermissions: channel.missingPermissions ?? [],
      })),
    [channelsQuery.data],
  );

  const voiceChannelMap = useMemo(
    () =>
      new Map(voiceChannels.map((channel) => [channel.value, channel.label])),
    [voiceChannels],
  );
  const textChannelMap = useMemo(
    () =>
      new Map(textChannels.map((channel) => [channel.value, channel.label])),
    [textChannels],
  );
  const voiceChannelAccess = useMemo(
    () => new Map(voiceChannels.map((channel) => [channel.value, channel])),
    [voiceChannels],
  );
  const textChannelAccess = useMemo(
    () => new Map(textChannels.map((channel) => [channel.value, channel])),
    [textChannels],
  );
  const defaultNotesAccess = defaultNotesChannelId
    ? textChannelAccess.get(defaultNotesChannelId)
    : undefined;
  const defaultNotesLabel = defaultNotesAccess
    ? formatChannelLabel(defaultNotesAccess)
    : undefined;

  const overrides = useMemo(
    () =>
      buildChannelOverrides({
        channelRules,
        channelContexts,
        voiceChannelMap,
        textChannelMap,
        defaultNotesChannelId,
      }),
    [
      channelRules,
      channelContexts,
      voiceChannelMap,
      textChannelMap,
      defaultNotesChannelId,
    ],
  );

  const usedChannelIds = useMemo(
    () => new Set(overrides.map((override) => override.channelId)),
    [overrides],
  );
  const availableVoiceChannels = useMemo(
    () => voiceChannels.filter((channel) => !usedChannelIds.has(channel.value)),
    [voiceChannels, usedChannelIds],
  );
  const channelsRefreshing = channelsQuery.isFetching;

  const channelBusy =
    rulesQuery.isLoading ||
    channelsQuery.isLoading ||
    channelContextsQuery.isLoading ||
    addRuleMutation.isPending ||
    removeRuleMutation.isPending ||
    setChannelContextMutation.isPending ||
    clearChannelContextMutation.isPending;
  const configBusy =
    configQuery.isLoading || configQuery.isFetching || channelsQuery.isLoading;
  const configUiContext = useMemo(
    () => ({
      textChannels,
      ttsVoiceOptions: TTS_VOICE_OPTIONS,
    }),
    [textChannels],
  );

  const dictionaryBudgets = useMemo(() => {
    const snapshot = configQuery.data?.snapshot;
    if (!snapshot?.values) return DEFAULT_DICTIONARY_BUDGETS;
    const valuesByKey: Record<string, unknown> = {};
    Object.entries(snapshot.values).forEach(([key, entry]) => {
      valuesByKey[key] = entry.value;
    });
    return resolveDictionaryBudgets(valuesByKey, snapshot.tier);
  }, [configQuery.data?.snapshot]);

  const dictionaryBusy =
    dictionaryQuery.isLoading ||
    dictionaryUpsertMutation.isPending ||
    dictionaryRemoveMutation.isPending ||
    dictionaryClearMutation.isPending;
  const notionBusy =
    saveNotionAutomationMutation.isPending ||
    disableNotionAutomationMutation.isPending;

  const settingsInitialLoading =
    guildLoading ||
    !selectedGuildId ||
    rulesQuery.isLoading ||
    channelsQuery.isLoading ||
    configQuery.isLoading ||
    channelContextsQuery.isLoading ||
    dictionaryQuery.isLoading;

  const openAddChannel = () => {
    setEditingChannelId(null);
    setChannelVoiceChannelId(null);
    setChannelAutoRecord(true);
    setChannelTextChannelId(null);
    setChannelTags("");
    setChannelContext("");
    setChannelLiveVoiceMode("inherit");
    setChannelLiveVoiceCommandsMode("inherit");
    setChannelChatTtsMode("inherit");
    setChannelChatTtsTtsOnlyMode("inherit");
    channelModal.open();
  };

  const openEditChannel = (override: ChannelOverride) => {
    setEditingChannelId(override.channelId);
    setChannelVoiceChannelId(override.channelId);
    setChannelAutoRecord(override.autoRecordEnabled);
    setChannelTextChannelId(override.textChannelId ?? null);
    setChannelTags(override.tags?.join(", ") ?? "");
    setChannelContext(override.context ?? "");
    setChannelLiveVoiceMode(overrideModeFromBoolean(override.liveVoiceEnabled));
    setChannelLiveVoiceCommandsMode(
      overrideModeFromBoolean(override.liveVoiceCommandsEnabled),
    );
    setChannelChatTtsMode(overrideModeFromBoolean(override.chatTtsEnabled));
    setChannelChatTtsTtsOnlyMode(
      overrideModeFromBoolean(override.chatTtsTtsOnlyEnabled),
    );
    channelModal.open();
  };

  const closeChannelModal = () => {
    channelModal.close();
  };

  const selectedVoiceChannel = channelVoiceChannelId
    ? voiceChannelAccess.get(channelVoiceChannelId)
    : undefined;
  const effectiveChannelChatTtsEnabled =
    channelChatTtsMode === "inherit"
      ? serverChatTtsEnabled
      : channelChatTtsMode === "on";
  const effectiveChannelTtsOnlyEnabled =
    channelChatTtsTtsOnlyMode === "inherit"
      ? serverTtsOnlyEnabled
      : channelChatTtsTtsOnlyMode === "on";
  const channelNeedsStatusChannel =
    channelAutoRecord ||
    (effectiveChannelChatTtsEnabled && effectiveChannelTtsOnlyEnabled);
  const resolvedTextChannelId = channelNeedsStatusChannel
    ? (channelTextChannelId ?? defaultNotesChannelId ?? null)
    : null;
  const selectedTextChannel = resolvedTextChannelId
    ? textChannelAccess.get(resolvedTextChannelId)
    : undefined;
  const voiceMissingPermissions =
    selectedVoiceChannel && !selectedVoiceChannel.botAccess
      ? selectedVoiceChannel.missingPermissions
      : [];
  const textMissingPermissions =
    selectedTextChannel && !selectedTextChannel.botAccess
      ? selectedTextChannel.missingPermissions
      : [];

  const channelSaveDisabled =
    !selectedGuildId ||
    !channelVoiceChannelId ||
    voiceMissingPermissions.length > 0 ||
    (channelNeedsStatusChannel &&
      (!resolvedTextChannelId || textMissingPermissions.length > 0));

  const handleSaveChannel = async () => {
    if (!selectedGuildId || !channelVoiceChannelId) return;
    if (channelSaveDisabled) return;
    const existingOverride = overrides.find(
      (override) => override.channelId === channelVoiceChannelId,
    );
    const trimmedContext = channelContext.trim();
    const autoRecordTasks: Promise<unknown>[] = [];
    const contextTasks: Promise<unknown>[] = [];
    const liveVoiceOverride =
      channelLiveVoiceMode === "inherit" ? null : channelLiveVoiceMode === "on";
    const liveVoiceCommandsOverride =
      channelLiveVoiceCommandsMode === "inherit"
        ? null
        : channelLiveVoiceCommandsMode === "on";
    const chatTtsOverride =
      channelChatTtsMode === "inherit" ? null : channelChatTtsMode === "on";
    const chatTtsTtsOnlyOverride =
      channelChatTtsTtsOnlyMode === "inherit"
        ? null
        : channelChatTtsTtsOnlyMode === "on";
    const shouldManageContextTextChannel =
      !channelAutoRecord &&
      (channelNeedsStatusChannel ||
        existingOverride?.textChannelId !== undefined);
    const shouldUpdateContext =
      trimmedContext.length > 0 ||
      existingOverride?.context ||
      shouldManageContextTextChannel ||
      liveVoiceOverride !== null ||
      existingOverride?.liveVoiceEnabled !== undefined ||
      liveVoiceCommandsOverride !== null ||
      existingOverride?.liveVoiceCommandsEnabled !== undefined ||
      chatTtsOverride !== null ||
      existingOverride?.chatTtsEnabled !== undefined ||
      chatTtsTtsOnlyOverride !== null ||
      existingOverride?.chatTtsTtsOnlyEnabled !== undefined;
    if (shouldUpdateContext) {
      contextTasks.push(
        setChannelContextMutation.mutateAsync({
          serverId: selectedGuildId,
          channelId: channelVoiceChannelId,
          context: trimmedContext.length > 0 ? trimmedContext : undefined,
          defaultNotesChannelId: shouldManageContextTextChannel
            ? channelNeedsStatusChannel
              ? channelTextChannelId
              : null
            : undefined,
          liveVoiceEnabled: liveVoiceOverride,
          liveVoiceCommandsEnabled: liveVoiceCommandsOverride,
          chatTtsEnabled: chatTtsOverride,
          chatTtsTtsOnlyEnabled: chatTtsTtsOnlyOverride,
        }),
      );
    }

    if (channelAutoRecord) {
      autoRecordTasks.push(
        addRuleMutation.mutateAsync({
          serverId: selectedGuildId,
          mode: "one",
          voiceChannelId: channelVoiceChannelId,
          textChannelId: channelTextChannelId ?? null,
          tags: parseTags(channelTags),
        }),
      );
    } else if (existingOverride?.autoRecordEnabled) {
      autoRecordTasks.push(
        removeRuleMutation.mutateAsync({
          serverId: selectedGuildId,
          channelId: channelVoiceChannelId,
        }),
      );
    }

    try {
      await Promise.all(autoRecordTasks);
      await Promise.all(contextTasks);
      await Promise.all([
        trpcUtils.autorecord.list.invalidate({ serverId: selectedGuildId }),
        trpcUtils.channelContexts.list.invalidate({
          serverId: selectedGuildId,
        }),
      ]);
      closeChannelModal();
    } catch (error) {
      console.error("Failed to save channel settings", error);
    }
  };

  const handleRemoveOverride = async (override: ChannelOverride) => {
    if (!selectedGuildId) return;
    const tasks: Promise<unknown>[] = [];
    if (override.autoRecordEnabled) {
      tasks.push(
        removeRuleMutation.mutateAsync({
          serverId: selectedGuildId,
          channelId: override.channelId,
        }),
      );
    }
    if (
      override.context ||
      override.defaultNotesChannelId !== undefined ||
      override.liveVoiceEnabled !== undefined ||
      override.liveVoiceCommandsEnabled !== undefined ||
      override.chatTtsEnabled !== undefined ||
      override.chatTtsTtsOnlyEnabled !== undefined
    ) {
      tasks.push(
        clearChannelContextMutation.mutateAsync({
          serverId: selectedGuildId,
          channelId: override.channelId,
        }),
      );
    }
    try {
      await Promise.all(tasks);
      await Promise.all([
        trpcUtils.autorecord.list.invalidate({ serverId: selectedGuildId }),
        trpcUtils.channelContexts.list.invalidate({
          serverId: selectedGuildId,
        }),
      ]);
    } catch (error) {
      console.error("Failed to remove channel override", error);
    }
  };

  const handleConnectNotion = () => {
    const redirect = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const url = `${buildApiUrl("/api/notion/connect")}?redirect=${encodeURIComponent(
      redirect,
    )}`;
    window.location.assign(url);
  };

  const handleSaveNotionAutomation = async (input: {
    destinationPageId: string;
    autoExportEnabled: boolean;
    channelIds: string[];
    tags: string[];
  }) => {
    if (!selectedGuildId) return;
    try {
      await saveNotionAutomationMutation.mutateAsync({
        serverId: selectedGuildId,
        ...input,
      });
      notifications.show({ message: "Notion automation saved." });
      await trpcUtils.notion.automationStatus.invalidate({
        serverId: selectedGuildId,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to save Notion automation right now.";
      notifications.show({ color: "red", message });
    }
  };

  const handleDisableNotionAutomation = async () => {
    if (!selectedGuildId) return;
    try {
      await disableNotionAutomationMutation.mutateAsync({
        serverId: selectedGuildId,
      });
      notifications.show({ message: "Notion automation disabled." });
      await trpcUtils.notion.automationStatus.invalidate({
        serverId: selectedGuildId,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to disable Notion automation right now.";
      notifications.show({ color: "red", message });
    }
  };

  if (settingsInitialLoading) {
    return <SettingsLoadingState />;
  }

  return (
    <Stack gap="xl" data-testid="settings-page">
      <PageHeader
        title="Server settings"
        description="Configure how Chronote records, tags, and summarizes this server."
      />

      <ServerConfigCard
        busy={configBusy || !selectedGuildId}
        registry={configQuery.data?.registry ?? []}
        snapshot={configQuery.data?.snapshot}
        overrides={configQuery.data?.overrides ?? []}
        uiContext={configUiContext}
        onSet={async (key, value) => {
          if (!selectedGuildId) return;
          await setServerConfigMutation.mutateAsync({
            serverId: selectedGuildId,
            key,
            value,
          });
        }}
        onClear={async (key) => {
          if (!selectedGuildId) return;
          await clearServerConfigMutation.mutateAsync({
            serverId: selectedGuildId,
            key,
          });
        }}
        onSaved={() =>
          selectedGuildId
            ? Promise.all([
                trpcUtils.config.server.invalidate({
                  serverId: selectedGuildId,
                }),
                trpcUtils.autorecord.list.invalidate({
                  serverId: selectedGuildId,
                }),
                trpcUtils.channelContexts.list.invalidate({
                  serverId: selectedGuildId,
                }),
              ])
            : Promise.resolve()
        }
      />

      <DictionaryCard
        busy={dictionaryBusy || !selectedGuildId}
        entries={dictionaryQuery.data?.entries ?? []}
        budgets={dictionaryBudgets}
        onUpsert={async (term, definition) => {
          if (!selectedGuildId) return;
          await dictionaryUpsertMutation.mutateAsync({
            serverId: selectedGuildId,
            term,
            definition,
          });
          await trpcUtils.dictionary.list.invalidate({
            serverId: selectedGuildId,
          });
        }}
        onRemove={async (term) => {
          if (!selectedGuildId) return;
          await dictionaryRemoveMutation.mutateAsync({
            serverId: selectedGuildId,
            term,
          });
          await trpcUtils.dictionary.list.invalidate({
            serverId: selectedGuildId,
          });
        }}
        onClear={async () => {
          if (!selectedGuildId) return;
          await dictionaryClearMutation.mutateAsync({
            serverId: selectedGuildId,
          });
          await trpcUtils.dictionary.list.invalidate({
            serverId: selectedGuildId,
          });
        }}
      />

      <NotionIntegrationCard
        status={notionStatusQuery.data}
        loading={notionStatusQuery.isLoading || notionStatusQuery.isFetching}
        busy={notionBusy}
        destinationPages={notionDestinationQuery.data?.pages ?? []}
        destinationLoading={
          notionDestinationQuery.isLoading || notionDestinationQuery.isFetching
        }
        voiceChannels={voiceChannels}
        onConnect={handleConnectNotion}
        onSearchDestinations={(query) => {
          const next = query.trim();
          setNotionDestinationSearch(next);
          if (notionDestinationSearch === next) {
            void notionDestinationQuery.refetch();
          }
        }}
        onSave={handleSaveNotionAutomation}
        onDisable={handleDisableNotionAutomation}
      />

      <ChannelOverridesCard
        busy={channelBusy}
        refreshing={channelsRefreshing}
        overrides={overrides}
        availableVoiceChannels={availableVoiceChannels}
        onRefresh={() => channelsQuery.refetch()}
        onAdd={openAddChannel}
        onSelect={(id) => {
          const found = overrides.find((o) => o.channelId === id);
          if (found) openEditChannel(found);
        }}
        onRemove={handleRemoveOverride}
      />

      <Modal
        opened={channelModalOpen}
        onClose={closeChannelModal}
        title={
          editingChannelId ? "Edit channel settings" : "Add channel settings"
        }
        overlayProps={uiOverlays.modal}
        data-testid="settings-channel-modal"
      >
        <Stack gap="sm">
          {editingChannelId ? (
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                Voice channel
              </Text>
              <Text fw={600}>
                {channelVoiceChannelId
                  ? (voiceChannelMap.get(channelVoiceChannelId) ??
                    "Unknown channel")
                  : "Unknown channel"}
              </Text>
              <Text size="xs" c="dimmed">
                Channel is fixed for this override.
              </Text>
            </Stack>
          ) : (
            <FormSelect
              label="Voice channel"
              placeholder={
                channelsQuery.isLoading ? "Loading..." : "Select voice channel"
              }
              data={availableVoiceChannels.map((channel) => ({
                value: channel.value,
                label: formatChannelLabel(channel),
              }))}
              value={channelVoiceChannelId}
              onChange={setChannelVoiceChannelId}
            />
          )}
          {voiceMissingPermissions.length > 0 ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="red"
              variant="light"
            >
              Bot needs access to join this channel (
              {voiceMissingPermissions.join(", ")}). Update channel permissions
              then refresh.
            </Alert>
          ) : null}
          <Switch
            label="Auto-record this channel"
            checked={channelAutoRecord}
            onChange={(event) =>
              setChannelAutoRecord(event.currentTarget.checked)
            }
          />
          {recordAllEnabled && !channelAutoRecord ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="yellow"
              variant="light"
            >
              Record-all is enabled. Disabling auto-record here will still fall
              back to the global setting.
            </Alert>
          ) : null}
          {channelNeedsStatusChannel ? (
            <FormSelect
              label={channelAutoRecord ? "Notes channel" : "Status channel"}
              placeholder={
                channelsQuery.isLoading ? "Loading..." : "Select channel"
              }
              data={[
                ...(defaultNotesChannelId
                  ? [
                      {
                        value: "__default",
                        label: `Use default (${defaultNotesLabel ?? "Default notes channel"})`,
                      },
                    ]
                  : []),
                ...textChannels.map((channel) => ({
                  value: channel.value,
                  label: formatChannelLabel(channel),
                })),
              ]}
              value={
                channelTextChannelId ??
                (defaultNotesChannelId ? "__default" : null)
              }
              onChange={(value) => {
                if (value === "__default") {
                  setChannelTextChannelId(null);
                } else {
                  setChannelTextChannelId(value);
                }
              }}
            />
          ) : null}
          {channelNeedsStatusChannel && !resolvedTextChannelId ? (
            <Text size="sm" c="red">
              Select a status channel or set a default notes channel first.
            </Text>
          ) : null}
          {channelNeedsStatusChannel && textMissingPermissions.length > 0 ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="red"
              variant="light"
            >
              Bot needs access to post status and notes (
              {textMissingPermissions.join(", ")}).
            </Alert>
          ) : null}
          {channelAutoRecord ? (
            <TextInput
              label="Tags"
              placeholder="campaign, recap"
              value={channelTags}
              onChange={(event) => setChannelTags(event.currentTarget.value)}
            />
          ) : null}
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              Live voice responder
            </Text>
            <SegmentedControl
              value={channelLiveVoiceMode}
              onChange={(value) =>
                setChannelLiveVoiceMode(value as "inherit" | "on" | "off")
              }
              data={[
                { label: "Use default", value: "inherit" },
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
              fullWidth
            />
            <Text size="xs" c="dimmed">
              Use default to inherit the server-wide setting.
            </Text>
          </Stack>
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              Live voice commands
            </Text>
            <SegmentedControl
              value={channelLiveVoiceCommandsMode}
              onChange={(value) =>
                setChannelLiveVoiceCommandsMode(
                  value as "inherit" | "on" | "off",
                )
              }
              data={[
                { label: "Use default", value: "inherit" },
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
              fullWidth
            />
            <Text size="xs" c="dimmed">
              Use default to inherit the server-wide setting.
            </Text>
          </Stack>
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              Chat-to-speech
            </Text>
            <SegmentedControl
              value={channelChatTtsMode}
              onChange={(value) =>
                setChannelChatTtsMode(value as "inherit" | "on" | "off")
              }
              data={[
                { label: "Use default", value: "inherit" },
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
              fullWidth
            />
            <Text size="xs" c="dimmed">
              Use default to inherit the server-wide setting.
            </Text>
          </Stack>
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              TTS-only auto-start
            </Text>
            <SegmentedControl
              value={channelChatTtsTtsOnlyMode}
              onChange={(value) =>
                setChannelChatTtsTtsOnlyMode(value as "inherit" | "on" | "off")
              }
              data={[
                { label: "Use default", value: "inherit" },
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
              fullWidth
            />
            <Text size="xs" c="dimmed">
              Allows chat TTS to join this voice channel without recording or
              transcribing.
            </Text>
          </Stack>
          <Textarea
            label="Channel context"
            minRows={4}
            placeholder="Optional instructions for meetings recorded in this channel"
            value={channelContext}
            onChange={(event) => setChannelContext(event.currentTarget.value)}
          />
          <Group justify="space-between" align="center">
            {voiceMissingPermissions.length > 0 ||
            textMissingPermissions.length > 0 ? (
              <Button
                variant="subtle"
                leftSection={<IconRefresh size={16} />}
                onClick={() => channelsQuery.refetch()}
                loading={channelsRefreshing}
                disabled={channelBusy}
                data-testid="settings-recheck-bot"
              >
                Recheck bot access
              </Button>
            ) : (
              <span />
            )}
            <Group gap="sm">
              <Button variant="default" onClick={closeChannelModal}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveChannel}
                disabled={channelSaveDisabled}
                data-testid="settings-save-channel"
              >
                Save channel
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
