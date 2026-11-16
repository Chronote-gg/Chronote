import { useAuthNavigationBlocker } from "../hooks/useAuthNavigationBlocker";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Group, Modal, Stack, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AskPageLayout } from "../features/ask/AskPageLayout";
import { useAskActions } from "../features/ask/useAskActions";
import { useAskPageEffects } from "../features/ask/useAskPageEffects";
import { trpc } from "../services/trpc";
import { useGuildContext } from "../contexts/GuildContext";
import type { AskConversation, AskMessage } from "../../types/ask";
import {
  buildDisplayMessages,
  resolveListMode,
  type ListMode,
} from "../utils/askLinks";
import {
  filterConversationsByQuery,
  prependOptimisticConversation,
  resolveAllowOptimistic,
  resolveCanExport,
  resolveConversationData,
  resolveDisplayTitle,
  resolveListIds,
  resolveListState,
  resolveNextConversationId,
  resolveShareActionDisabled,
  resolveShareBadgeLabel,
  resolveShareDisplayVisibility,
  resolveShareUrls,
} from "../features/ask/askPageState";

export default function Ask() {
  const { selectedGuildId, guilds } = useGuildContext();
  const trpcUtils = trpc.useUtils();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    list?: "mine" | "shared" | "archived";
    conversationId?: string;
    messageId?: string;
    meetingId?: string;
    eventId?: string;
  };
  const listMode = resolveListMode(search.list ?? null);
  const highlightedMessageId = search.messageId ?? null;
  const searchConversationId = search.conversationId || null;
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newConversationRequested, setNewConversationRequested] =
    useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveNextState, setArchiveNextState] = useState<boolean | null>(
    null,
  );
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  useAuthNavigationBlocker(Boolean(draft));
  useAuthNavigationBlocker(Boolean(renameDraft), renaming);
  useAuthNavigationBlocker(Boolean(feedbackDraft), feedbackModalOpen);
  const [pendingFeedback, setPendingFeedback] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);
  const [feedbackByMessage, setFeedbackByMessage] = useState<
    Record<string, "up" | "down">
  >({});
  const [optimisticMessages, setOptimisticMessages] = useState<AskMessage[]>(
    [],
  );
  const [optimisticConversation, setOptimisticConversation] =
    useState<AskConversation | null>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeId = isCreatingNew ? null : searchConversationId;
  const selectedGuild = selectedGuildId
    ? (guilds.find((guild) => guild.id === selectedGuildId) ?? null)
    : null;
  const canManage = selectedGuild?.canManage ?? false;

  const settingsQuery = trpc.ask.settings.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) },
  );
  const askMembersEnabled = settingsQuery.data?.askMembersEnabled ?? true;
  const askSharingPolicy = settingsQuery.data?.askSharingPolicy ?? "server";
  const sharingEnabled = askSharingPolicy !== "off";
  const publicSharingEnabled = askSharingPolicy === "public";
  const askAccessAllowed = canManage || askMembersEnabled;

  const listQuery = trpc.ask.listConversations.useQuery(
    { serverId: selectedGuildId ?? "" },
    {
      enabled: Boolean(selectedGuildId && askAccessAllowed),
      staleTime: 30_000,
    },
  );
  const sharedListQuery = trpc.ask.listSharedConversations.useQuery(
    { serverId: selectedGuildId ?? "" },
    {
      enabled: Boolean(
        selectedGuildId &&
        askAccessAllowed &&
        sharingEnabled &&
        listMode === "shared",
      ),
      staleTime: 30_000,
    },
  );
  const conversationQuery = trpc.ask.getConversation.useQuery(
    { serverId: selectedGuildId ?? "", conversationId: activeId ?? "" },
    {
      enabled: Boolean(
        selectedGuildId &&
        askAccessAllowed &&
        activeId &&
        listMode !== "shared",
      ),
      staleTime: 30_000,
      placeholderData: (prev) =>
        prev?.conversation?.id === activeId ? prev : undefined,
    },
  );
  const sharedConversationQuery = trpc.ask.getSharedConversation.useQuery(
    { serverId: selectedGuildId ?? "", conversationId: activeId ?? "" },
    {
      enabled: Boolean(
        selectedGuildId &&
        askAccessAllowed &&
        activeId &&
        listMode === "shared" &&
        sharingEnabled,
      ),
      staleTime: 30_000,
      placeholderData: (prev) =>
        prev?.conversation?.id === activeId ? prev : undefined,
    },
  );
  const askMutation = trpc.ask.ask.useMutation();
  const renameMutation = trpc.ask.rename.useMutation();
  const shareMutation = trpc.ask.setVisibility.useMutation();
  const archiveMutation = trpc.ask.setArchived.useMutation();
  const feedbackMutation = trpc.feedback.submitAsk.useMutation();

  const mineConversations = listQuery.data?.conversations ?? [];
  const sharedConversations = sharedListQuery.data?.conversations ?? [];
  const listState = resolveListState({
    listMode,
    listQuery,
    sharedListQuery,
    conversationQuery,
    sharedConversationQuery,
  });
  const activeConversations = useMemo(
    () => mineConversations.filter((conv) => !conv.archivedAt),
    [mineConversations],
  );
  const archivedConversations = useMemo(
    () => mineConversations.filter((conv) => conv.archivedAt),
    [mineConversations],
  );
  const { listBusy, conversationBusy, listError, conversationError } =
    listState;
  const { activeConversation, activeMessages, sharedMeta } =
    resolveConversationData({
      listMode,
      isCreatingNew,
      activeId,
      conversationData: conversationQuery.data,
      sharedConversationData: sharedConversationQuery.data,
    });

  const navigateToConversation = useCallback(
    (conversationId: string | null, mode: ListMode) => {
      if (!selectedGuildId) return;
      navigate({
        to: "/portal/server/$serverId/ask",
        params: { serverId: selectedGuildId },
        search: (prev) => ({
          ...prev,
          list: mode,
          conversationId: conversationId ?? undefined,
          messageId: undefined,
        }),
      });
    },
    [navigate, selectedGuildId],
  );

  const handleListModeChange = useCallback(
    (mode: ListMode) => {
      setIsCreatingNew(false);
      setNewConversationRequested(false);
      const nextId = resolveNextConversationId({
        mode,
        activeId,
        activeConversations,
        archivedConversations,
        sharedConversations,
      });
      navigateToConversation(nextId, mode);
    },
    [
      activeId,
      activeConversations,
      archivedConversations,
      sharedConversations,
      navigateToConversation,
    ],
  );

  const listIds = useMemo(
    () =>
      resolveListIds({
        listMode,
        activeConversations,
        archivedConversations,
        sharedConversations,
      }),
    [listMode, activeConversations, archivedConversations, sharedConversations],
  );

  const filteredMine = useMemo(
    () =>
      filterConversationsByQuery({
        query,
        source: prependOptimisticConversation(
          activeConversations,
          optimisticConversation,
        ),
        toSearchText: (conv) => `${conv.title} ${conv.summary}`,
      }),
    [query, activeConversations, optimisticConversation],
  );

  const filteredArchived = useMemo(
    () =>
      filterConversationsByQuery({
        query,
        source: archivedConversations,
        toSearchText: (conv) => `${conv.title} ${conv.summary}`,
      }),
    [query, archivedConversations],
  );

  const filteredShared = useMemo(
    () =>
      filterConversationsByQuery({
        query,
        source: sharedConversations,
        toSearchText: (conv) =>
          `${conv.title} ${conv.summary} ${conv.ownerTag ?? ""}`,
      }),
    [query, sharedConversations],
  );

  const displayTitle = resolveDisplayTitle(
    activeConversation,
    optimisticConversation,
  );
  const isArchived = Boolean(activeConversation?.archivedAt);
  const activeVisibility = activeConversation?.visibility ?? "private";
  const shareDisplayVisibility = resolveShareDisplayVisibility(
    activeVisibility,
    publicSharingEnabled,
  );
  const isShared = activeVisibility !== "private";
  const shareBadgeLabel = resolveShareBadgeLabel(shareDisplayVisibility);
  const shareActionDisabled = resolveShareActionDisabled({
    selectedGuildId,
    activeConversation,
    listMode,
    isArchived,
    sharingEnabled,
    askAccessAllowed,
  });
  const origin = typeof window !== "undefined" ? window.location.origin : null;
  const { shareUrl } = resolveShareUrls({
    origin,
    selectedGuildId,
    activeConversation,
    shareDisplayVisibility,
  });
  const canExport = resolveCanExport(activeConversation, listMode);
  const allowOptimistic = resolveAllowOptimistic(listMode, isArchived);
  const activeConversationId = activeConversation?.id ?? activeId;
  const feedbackKeyForMessage = useCallback(
    (messageId: string) =>
      activeConversationId ? `${activeConversationId}:${messageId}` : messageId,
    [activeConversationId],
  );
  const feedbackStateForMessage = useCallback(
    (messageId: string) =>
      feedbackByMessage[feedbackKeyForMessage(messageId)] ?? null,
    [feedbackByMessage, feedbackKeyForMessage],
  );
  const feedbackEnabled =
    listMode === "mine" && Boolean(activeConversationId) && !isArchived;
  const displayMessages = useMemo(() => {
    const pending = allowOptimistic ? askMutation.isPending : false;
    return buildDisplayMessages({
      activeConversation,
      activeId,
      activeMessages,
      optimisticMessages: allowOptimistic ? optimisticMessages : [],
      isPending: pending,
    });
  }, [
    activeConversation,
    activeId,
    activeMessages,
    optimisticMessages,
    askMutation.isPending,
    allowOptimistic,
  ]);

  useAskPageEffects({
    selectedGuildId,
    askAccessAllowed,
    listMode,
    sharingEnabled,
    activeId,
    activeConversation,
    activeConversations,
    archivedConversations,
    sharedConversations,
    listIds,
    listBusy,
    conversationBusy,
    isCreatingNew,
    newConversationRequested,
    askPending: askMutation.isPending,
    highlightedMessageId,
    displayMessagesLength: displayMessages.length,
    chatViewportRef,
    inputRef,
    navigateToConversation,
    setOptimisticMessages,
    setOptimisticConversation,
    setIsCreatingNew,
    setNewConversationRequested,
    setRenameDraft,
    setRenaming,
    setRenameError,
    setArchiveError,
    optimisticMessages,
    activeMessages,
  });

  const submitAskFeedback = useCallback(
    async (
      rating: "up" | "down",
      conversationId: string,
      messageId: string,
      comment?: string,
    ) => {
      if (!selectedGuildId) return;
      try {
        await feedbackMutation.mutateAsync({
          serverId: selectedGuildId,
          conversationId,
          messageId,
          rating,
          comment,
        });
        setFeedbackByMessage((prev) => ({
          ...prev,
          [`${conversationId}:${messageId}`]: rating,
        }));
        notifications.show({
          color: "green",
          message: "Thanks for the feedback.",
        });
      } catch {
        notifications.show({
          color: "red",
          message: "Unable to submit feedback right now.",
        });
      }
    },
    [feedbackMutation, selectedGuildId],
  );

  const handleAskFeedbackUp = useCallback(
    (messageId: string) => {
      if (!activeConversationId) return;
      void submitAskFeedback("up", activeConversationId, messageId);
    },
    [activeConversationId, submitAskFeedback],
  );

  const handleAskFeedbackDown = useCallback(
    (messageId: string) => {
      if (!activeConversationId) return;
      setPendingFeedback({ conversationId: activeConversationId, messageId });
      setFeedbackDraft("");
      setFeedbackModalOpen(true);
    },
    [activeConversationId],
  );

  const handleAskFeedbackSubmit = useCallback(async () => {
    if (!pendingFeedback) return;
    await submitAskFeedback(
      "down",
      pendingFeedback.conversationId,
      pendingFeedback.messageId,
      feedbackDraft,
    );
    setFeedbackModalOpen(false);
    setPendingFeedback(null);
    setFeedbackDraft("");
  }, [feedbackDraft, pendingFeedback, submitAskFeedback]);
  const actions = useAskActions({
    selectedGuildId,
    listMode,
    askAccessAllowed,
    isArchived,
    displayTitle,
    shareDisplayVisibility,
    shareBadgeLabel,
    shareActionDisabled,
    shareUrl,
    activeVisibility,
    isShared,
    sharingEnabled,
    publicSharingEnabled,
    canExport,
    displayMessages,
    activeConversation,
    activeId,
    sharedMeta,
    listBusy,
    conversationBusy,
    conversationError,
    highlightedMessageId,
    chatViewportRef,
    inputRef,
    showFeedback: feedbackEnabled,
    feedbackState: feedbackStateForMessage,
    feedbackPending: feedbackMutation.isPending,
    onFeedbackUp: handleAskFeedbackUp,
    onFeedbackDown: handleAskFeedbackDown,
    draft,
    setDraft,
    errorMessage,
    setErrorMessage,
    renameDraft,
    setRenameDraft,
    renaming,
    setRenaming,
    renameError,
    setRenameError,
    shareError,
    setShareError,
    archiveError,
    setArchiveError,
    shareModalOpen,
    setShareModalOpen,
    archiveModalOpen,
    setArchiveModalOpen,
    archiveNextState,
    setArchiveNextState,
    setOptimisticMessages,
    setOptimisticConversation,
    setIsCreatingNew,
    setNewConversationRequested,
    navigateToConversation,
    trpcUtils,
    askMutation,
    renameMutation,
    shareMutation,
    archiveMutation,
  });

  return (
    <>
      <AskPageLayout
        shareModalProps={actions.shareModalProps}
        archiveModalProps={actions.archiveModalProps}
        listMode={listMode}
        query={query}
        onQueryChange={setQuery}
        mineConversations={filteredMine}
        archivedConversations={filteredArchived}
        sharedConversations={filteredShared}
        listBusy={listBusy}
        listError={listError}
        activeId={activeId}
        onNewConversation={actions.handleNewConversation}
        onNavigateConversation={(id, mode) => {
          setIsCreatingNew(false);
          navigateToConversation(id, mode);
        }}
        onListModeChange={handleListModeChange}
        sharingEnabled={sharingEnabled}
        askAccessAllowed={askAccessAllowed}
        conversationPaneProps={actions.conversationPaneProps}
      />
      <Modal
        opened={feedbackModalOpen}
        onClose={() => {
          setFeedbackModalOpen(false);
          setPendingFeedback(null);
          setFeedbackDraft("");
        }}
        title="Ask feedback"
        centered
      >
        <Stack gap="md">
          <Textarea
            label="What could be better? (optional)"
            placeholder="Share details to help improve the answer."
            value={feedbackDraft}
            onChange={(event) => setFeedbackDraft(event.currentTarget.value)}
            minRows={4}
            maxLength={1000}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setFeedbackModalOpen(false);
                setPendingFeedback(null);
                setFeedbackDraft("");
              }}
              disabled={feedbackMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleAskFeedbackSubmit}
              loading={feedbackMutation.isPending}
            >
              Send feedback
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
