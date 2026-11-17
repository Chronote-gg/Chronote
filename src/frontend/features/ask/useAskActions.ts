import type { Dispatch, RefObject, SetStateAction } from "react";
import { notifications } from "@mantine/notifications";
import type {
  AskConversation,
  AskConversationVisibility,
  AskMessage,
  AskSharedConversation,
} from "../../../types/ask";
import type { ListMode } from "../../utils/askLinks";
import { buildAskUrl } from "../../utils/askLinks";
import { resolveNowMs } from "../../utils/now";
import { trpc } from "../../services/trpc";
import {
  buildConversationDetailUpdate,
  buildConversationListUpdate,
  buildConversationMessagesUpdate,
  buildOptimisticConversation,
  buildOptimisticUserMessage,
  canSubmitAsk,
} from "./askConversationUtils";
import type { AskArchiveModalProps } from "./AskArchiveModal";
import type { AskConversationPaneProps } from "./AskConversationPane";
import type { AskShareModalProps } from "./AskShareModal";
import { exportAskThread } from "./askExportActions";

type AskActionsOptions = {
  contextMeetingIds?: string[];
  onAskAccepted?: () => void;
  onNewRun?: () => void;
  selectedGuildId: string | null;
  listMode: ListMode;
  askAccessAllowed: boolean;
  isArchived: boolean;
  displayTitle: string;
  shareDisplayVisibility: AskConversationVisibility;
  shareBadgeLabel: string;
  shareActionDisabled: boolean;
  shareUrl: string;
  activeVisibility: AskConversationVisibility;
  isShared: boolean;
  sharingEnabled: boolean;
  publicSharingEnabled: boolean;
  canExport: boolean;
  displayMessages: AskMessage[];
  activeConversation: AskConversation | null;
  activeId: string | null;
  sharedMeta: AskSharedConversation | null;
  listBusy: boolean;
  conversationBusy: boolean;
  conversationError: unknown;
  highlightedMessageId: string | null;
  chatViewportRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  showFeedback: boolean;
  feedbackState: (messageId: string) => "up" | "down" | null;
  feedbackPending: boolean;
  onFeedbackUp: (messageId: string) => void;
  onFeedbackDown: (messageId: string) => void;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  errorMessage: string | null;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  renameDraft: string;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  renaming: boolean;
  setRenaming: Dispatch<SetStateAction<boolean>>;
  renameError: string | null;
  setRenameError: Dispatch<SetStateAction<string | null>>;
  shareError: string | null;
  setShareError: Dispatch<SetStateAction<string | null>>;
  archiveError: string | null;
  setArchiveError: Dispatch<SetStateAction<string | null>>;
  shareModalOpen: boolean;
  setShareModalOpen: Dispatch<SetStateAction<boolean>>;
  archiveModalOpen: boolean;
  setArchiveModalOpen: Dispatch<SetStateAction<boolean>>;
  archiveNextState: boolean | null;
  setArchiveNextState: Dispatch<SetStateAction<boolean | null>>;
  setOptimisticMessages: Dispatch<SetStateAction<AskMessage[]>>;
  setOptimisticConversation: Dispatch<SetStateAction<AskConversation | null>>;
  setIsCreatingNew: Dispatch<SetStateAction<boolean>>;
  setNewConversationRequested: Dispatch<SetStateAction<boolean>>;
  navigateToConversation: (
    conversationId: string | null,
    mode: ListMode,
  ) => void;
  trpcUtils: ReturnType<typeof trpc.useUtils>;
  askMutation: {
    isPending: boolean;
    mutateAsync: (input: {
      serverId: string;
      conversationId?: string;
      question: string;
      contextMeetingIds?: string[];
    }) => Promise<{
      conversationId: string;
      conversation: AskConversation;
      messages: AskMessage[];
    }>;
  };
  renameMutation: ReturnType<typeof trpc.ask.rename.useMutation>;
  shareMutation: ReturnType<typeof trpc.ask.setVisibility.useMutation>;
  archiveMutation: ReturnType<typeof trpc.ask.setArchived.useMutation>;
};

type AskActionsResult = {
  handleNewConversation: () => void;
  shareModalProps: AskShareModalProps;
  archiveModalProps: AskArchiveModalProps;
  conversationPaneProps: AskConversationPaneProps;
};

export const useAskActions = (options: AskActionsOptions): AskActionsResult => {
  const {
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
    showFeedback,
    feedbackState,
    feedbackPending,
    onFeedbackUp,
    onFeedbackDown,
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
  } = options;

  const handleExport = (format: "json" | "text") => {
    exportAskThread({
      format,
      selectedGuildId,
      activeConversation,
      displayMessages,
      canExport,
    });
  };

  const handleNewConversation = () => {
    options.onNewRun?.();
    setNewConversationRequested(true);
    setIsCreatingNew(true);
    setDraft("");
    setErrorMessage(null);
    setOptimisticMessages([]);
    setOptimisticConversation(null);
    navigateToConversation(null, "mine");
  };

  const handleAsk = async () => {
    const question = draft.trim();
    if (
      !canSubmitAsk({
        selectedGuildId,
        question,
        listMode,
        askAccessAllowed,
        isArchived,
      })
    ) {
      return;
    }
    if (!selectedGuildId) {
      return;
    }
    setErrorMessage(null);
    const now = new Date(resolveNowMs()).toISOString();
    setOptimisticMessages([buildOptimisticUserMessage(question, now)]);
    if (!activeConversation) {
      setOptimisticConversation(buildOptimisticConversation(question, now));
    }
    try {
      const result = await askMutation.mutateAsync({
        contextMeetingIds: options.contextMeetingIds,
        serverId: selectedGuildId,
        question,
        conversationId: activeId ?? undefined,
      });
      options.onAskAccepted?.();
      setDraft("");
      navigateToConversation(result.conversationId, "mine");
      setIsCreatingNew(false);
      setOptimisticMessages([]);
      setOptimisticConversation(null);
      trpcUtils.ask.listConversations.setData(
        { serverId: selectedGuildId },
        buildConversationListUpdate(result.conversation),
      );
      trpcUtils.ask.getConversation.setData(
        {
          serverId: selectedGuildId,
          conversationId: result.conversation.id,
        },
        buildConversationMessagesUpdate(result.conversation, result.messages),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setErrorMessage(
        err instanceof Error ? err.message : "Unable to reach Chronote.",
      );
      setOptimisticConversation(null);
    }
  };

  const handleRenameSave = async () => {
    if (!selectedGuildId || !activeConversation || listMode !== "mine") return;
    const title = renameDraft.trim();
    if (!title) {
      setRenameDraft(activeConversation.title);
      setRenaming(false);
      return;
    }
    setRenameError(null);
    try {
      await renameMutation.mutateAsync({
        serverId: selectedGuildId,
        conversationId: activeConversation.id,
        title,
      });
      await Promise.all([
        trpcUtils.ask.listConversations.invalidate({
          serverId: selectedGuildId,
        }),
        trpcUtils.ask.getConversation.invalidate({
          serverId: selectedGuildId,
          conversationId: activeConversation.id,
        }),
      ]);
      setRenaming(false);
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Unable to rename chat.",
      );
    }
  };

  const handleCopyLink = async (
    messageId?: string,
    mode: ListMode = listMode,
  ) => {
    if (!selectedGuildId || !activeConversation || !window?.location?.origin) {
      return;
    }
    const url = buildAskUrl({
      origin: window.location.origin,
      serverId: selectedGuildId,
      conversationId: activeConversation.id,
      listMode: mode,
      messageId,
    });
    try {
      await navigator.clipboard.writeText(url);
      notifications.show({
        color: "green",
        message: messageId
          ? "Message link copied."
          : "Conversation link copied.",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message: "Unable to copy the link. Please try again.",
      });
      console.error("Failed to copy link", err);
    }
  };

  const handleCopyResponse = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notifications.show({
        color: "green",
        message: "Response copied to clipboard.",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message: "Unable to copy the response. Please try again.",
      });
      console.error("Failed to copy response", err);
    }
  };

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      notifications.show({
        color: "green",
        message: "Share link copied to clipboard.",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message: "Unable to copy the share link. Please try again.",
      });
      console.error("Failed to copy share link", err);
    }
  };

  const updateConversationCaches = (conversation: AskConversation) => {
    const serverId = selectedGuildId ?? "";
    trpcUtils.ask.listConversations.setData(
      { serverId },
      buildConversationListUpdate(conversation),
    );
    trpcUtils.ask.getConversation.setData(
      { serverId, conversationId: conversation.id },
      buildConversationDetailUpdate(conversation),
    );
  };

  const handleShareChange = async (
    nextVisibility: AskConversationVisibility,
  ) => {
    if (!selectedGuildId || !activeConversation) return;
    setShareError(null);
    try {
      const result = await shareMutation.mutateAsync({
        serverId: selectedGuildId,
        conversationId: activeConversation.id,
        visibility: nextVisibility,
      });
      updateConversationCaches(result.conversation);
      await trpcUtils.ask.listSharedConversations.invalidate({
        serverId: selectedGuildId,
      });
      setShareModalOpen(false);
    } catch (err) {
      setShareError(
        err instanceof Error ? err.message : "Unable to update sharing.",
      );
    }
  };

  const closeArchiveOverlays = () => {
    setShareModalOpen(false);
    setRenaming(false);
  };

  const maybeExitArchivedView = (conversationId: string, archived: boolean) => {
    if (!archived && listMode === "archived") {
      navigateToConversation(conversationId, "mine");
    }
  };

  const handleArchiveToggle = async (archived: boolean): Promise<boolean> => {
    if (!selectedGuildId || !activeConversation) return false;
    if (listMode === "shared") return false;
    setArchiveError(null);
    try {
      const result = await archiveMutation.mutateAsync({
        serverId: selectedGuildId,
        conversationId: activeConversation.id,
        archived,
      });
      closeArchiveOverlays();
      updateConversationCaches(result.conversation);
      await trpcUtils.ask.listSharedConversations.invalidate({
        serverId: selectedGuildId,
      });
      maybeExitArchivedView(result.conversation.id, archived);
      return true;
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Unable to update archive state.",
      );
      return false;
    }
  };

  const handleArchiveConfirm = async () => {
    if (archiveNextState === null) return;
    const ok = await handleArchiveToggle(archiveNextState);
    if (!ok) return;
    setArchiveModalOpen(false);
    setArchiveNextState(null);
  };

  const handleShareModalClose = () => {
    setShareModalOpen(false);
    setShareError(null);
  };

  const handleArchiveModalClose = () => {
    setArchiveModalOpen(false);
    setArchiveNextState(null);
  };

  const handleArchiveOpen = () => {
    setArchiveError(null);
    setArchiveNextState(!isArchived);
    setArchiveModalOpen(true);
  };

  const handleRenameCancel = () => {
    setRenameDraft(activeConversation?.title ?? displayTitle);
    setRenaming(false);
  };

  const shareModalProps: AskShareModalProps = {
    opened: shareModalOpen,
    onClose: handleShareModalClose,
    publicSharingEnabled,
    sharingEnabled,
    activeConversation,
    isShared,
    shareDisplayVisibility,
    shareUrl,
    activeVisibility,
    shareError,
    onCopyShareLink: handleCopyShareLink,
    onShareChange: handleShareChange,
    sharePending: shareMutation.isPending,
  };

  const archiveModalProps: AskArchiveModalProps = {
    opened: archiveModalOpen,
    onClose: handleArchiveModalClose,
    title: archiveNextState ? "Archive chat" : "Unarchive chat",
    description: archiveNextState
      ? "Archived chats move to the Archived list and become read only. You can unarchive anytime."
      : "This chat will move back to My chats and become editable.",
    confirmColor: archiveNextState ? "red" : "brand",
    loading: archiveMutation.isPending,
    onConfirm: handleArchiveConfirm,
  };

  const conversationPaneProps: AskConversationPaneProps = {
    listBusy,
    conversationBusy,
    listMode,
    activeConversation,
    sharedMeta,
    displayTitle,
    isShared,
    shareDisplayVisibility,
    shareBadgeLabel,
    isArchived,
    shareActionDisabled,
    canExport,
    renaming,
    showRename:
      listMode === "mine" &&
      Boolean(activeConversation && displayMessages.length > 0) &&
      !isArchived,
    renameDraft,
    renameError,
    archiveError,
    selectedGuildId,
    renameLoading: renameMutation.isPending,
    archiveLoading: archiveMutation.isPending,
    askAccessAllowed,
    sharingEnabled,
    conversationError,
    displayMessages,
    highlightedMessageId,
    onCopyLink: handleCopyLink,
    onCopyResponse: handleCopyResponse,
    showFeedback,
    feedbackState,
    feedbackPending,
    onFeedbackUp,
    onFeedbackDown,
    chatViewportRef,
    draft,
    errorMessage,
    askPending: askMutation.isPending,
    inputRef,
    onAsk: handleAsk,
    onDraftChange: setDraft,
    onRenameDraftChange: setRenameDraft,
    onRenameSave: handleRenameSave,
    onRenameCancel: handleRenameCancel,
    onRenameStart: () => setRenaming(true),
    onShareOpen: () => setShareModalOpen(true),
    onArchiveOpen: handleArchiveOpen,
    onNewConversation: handleNewConversation,
    onExport: handleExport,
  };

  return {
    handleNewConversation,
    shareModalProps,
    archiveModalProps,
    conversationPaneProps,
  };
};
