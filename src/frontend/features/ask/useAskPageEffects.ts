import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AskConversation,
  AskMessage,
  AskSharedConversation,
} from "../../../types/ask";
import type { ListMode } from "../../utils/askLinks";
import { resolveNextConversationId } from "./askPageState";

type AskPageEffectsOptions = {
  focusReady?: boolean;
  selectedGuildId: string | null;
  askAccessAllowed: boolean;
  listMode: ListMode;
  sharingEnabled: boolean;
  activeId: string | null;
  activeConversation: AskConversation | null;
  activeConversations: AskConversation[];
  archivedConversations: AskConversation[];
  sharedConversations: AskSharedConversation[];
  listIds: string[];
  listBusy: boolean;
  conversationBusy: boolean;
  isCreatingNew: boolean;
  newConversationRequested: boolean;
  askPending: boolean;
  highlightedMessageId: string | null;
  displayMessagesLength: number;
  streamContentLength?: number;
  chatViewportRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  navigateToConversation: (
    conversationId: string | null,
    mode: ListMode,
  ) => void;
  setOptimisticMessages: Dispatch<SetStateAction<AskMessage[]>>;
  setOptimisticConversation: Dispatch<SetStateAction<AskConversation | null>>;
  setIsCreatingNew: Dispatch<SetStateAction<boolean>>;
  setNewConversationRequested: Dispatch<SetStateAction<boolean>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenaming: Dispatch<SetStateAction<boolean>>;
  setRenameError: Dispatch<SetStateAction<string | null>>;
  setArchiveError: Dispatch<SetStateAction<string | null>>;
  optimisticMessages: AskMessage[];
  activeMessages: AskMessage[];
};

const resetOnGuildChange = ({
  selectedGuildId,
  askAccessAllowed,
  setOptimisticMessages,
  setOptimisticConversation,
  setIsCreatingNew,
}: Pick<
  AskPageEffectsOptions,
  | "selectedGuildId"
  | "askAccessAllowed"
  | "setOptimisticMessages"
  | "setOptimisticConversation"
  | "setIsCreatingNew"
>) => {
  if (!selectedGuildId) {
    setOptimisticMessages([]);
    setOptimisticConversation(null);
    setIsCreatingNew(false);
    return;
  }
  if (!askAccessAllowed) {
    setIsCreatingNew(false);
  }
};

const applyListModeGuards = ({
  listMode,
  sharingEnabled,
  activeId,
  isCreatingNew,
  newConversationRequested,
  navigateToConversation,
  setIsCreatingNew,
  previousListMode,
}: Pick<
  AskPageEffectsOptions,
  | "listMode"
  | "sharingEnabled"
  | "activeId"
  | "isCreatingNew"
  | "newConversationRequested"
  | "navigateToConversation"
  | "setIsCreatingNew"
> & {
  previousListMode: ListMode;
}) => {
  if (listMode === "shared") {
    if (!sharingEnabled && activeId) {
      navigateToConversation(null, listMode);
    }
    if (isCreatingNew && !newConversationRequested) {
      setIsCreatingNew(false);
    }
    return;
  }
  if (listMode !== "archived") return;
  if (!isCreatingNew) return;
  if (previousListMode === "archived") return;
  if (newConversationRequested) return;
  setIsCreatingNew(false);
};

const shouldSkipListSync = ({
  selectedGuildId,
  askAccessAllowed,
  listMode,
  sharingEnabled,
  listBusy,
  conversationBusy,
  isCreatingNew,
}: Pick<
  AskPageEffectsOptions,
  | "selectedGuildId"
  | "askAccessAllowed"
  | "listMode"
  | "sharingEnabled"
  | "listBusy"
  | "conversationBusy"
  | "isCreatingNew"
>) =>
  !selectedGuildId ||
  !askAccessAllowed ||
  (listMode === "shared" && !sharingEnabled) ||
  listBusy ||
  conversationBusy ||
  isCreatingNew;

const canAllowMissingFromList = ({
  activeConversation,
  activeId,
  listMode,
}: Pick<
  AskPageEffectsOptions,
  "activeConversation" | "activeId" | "listMode"
>) => {
  if (!activeConversation || activeConversation.id !== activeId) return false;
  if (listMode === "shared") return true;
  return listMode === "archived" && Boolean(activeConversation.archivedAt);
};

const syncActiveConversation = ({
  selectedGuildId,
  askAccessAllowed,
  listMode,
  sharingEnabled,
  listBusy,
  conversationBusy,
  isCreatingNew,
  listIds,
  activeId,
  sharedConversations,
  activeConversations,
  archivedConversations,
  activeConversation,
  navigateToConversation,
}: Pick<
  AskPageEffectsOptions,
  | "selectedGuildId"
  | "askAccessAllowed"
  | "listMode"
  | "sharingEnabled"
  | "listBusy"
  | "conversationBusy"
  | "isCreatingNew"
  | "listIds"
  | "activeId"
  | "sharedConversations"
  | "activeConversations"
  | "archivedConversations"
  | "activeConversation"
  | "navigateToConversation"
>) => {
  if (
    shouldSkipListSync({
      selectedGuildId,
      askAccessAllowed,
      listMode,
      sharingEnabled,
      listBusy,
      conversationBusy,
      isCreatingNew,
    })
  ) {
    return;
  }
  const allowMissingFromList = canAllowMissingFromList({
    activeConversation,
    activeId,
    listMode,
  });
  if (listIds.length === 0) {
    if (activeId && !allowMissingFromList) {
      navigateToConversation(null, listMode);
    }
    return;
  }
  const hasActive = activeId && listIds.includes(activeId);
  if (hasActive || allowMissingFromList) return;
  const nextId = resolveNextConversationId({
    mode: listMode,
    activeId,
    sharedConversations,
    activeConversations,
    archivedConversations,
  });
  if (nextId) {
    navigateToConversation(nextId, listMode);
  }
};

const requestInputFocus = (
  inputRef: RefObject<HTMLTextAreaElement | null>,
  allowedElement: Element | null,
  onAttempt?: () => void,
) => {
  const handle = window.requestAnimationFrame(() => {
    onAttempt?.();
    if (!window.matchMedia("(min-width: 62em) and (pointer: fine)").matches)
      return;
    if (
      document.activeElement !== document.body &&
      document.activeElement !== inputRef.current &&
      document.activeElement !== allowedElement
    )
      return;
    inputRef.current?.focus({ preventScroll: true });
  });
  return () => window.cancelAnimationFrame(handle);
};

export const useAskPageEffects = ({
  focusReady = true,
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
  askPending,
  highlightedMessageId,
  displayMessagesLength,
  streamContentLength = 0,
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
}: AskPageEffectsOptions) => {
  const previousListModeRef = useRef<ListMode>(listMode);
  const initialFocusGuildRef = useRef<string | null>(null);
  const entryFocusRef = useRef(document.activeElement);
  const newChatFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (isCreatingNew) newChatFocusRef.current = document.activeElement;
  }, [isCreatingNew]);

  useEffect(() => {
    if (
      !selectedGuildId ||
      !focusReady ||
      !askAccessAllowed ||
      listBusy ||
      conversationBusy ||
      listMode !== "mine" ||
      activeId ||
      activeConversation ||
      isCreatingNew ||
      highlightedMessageId
    )
      return;
    if (initialFocusGuildRef.current === selectedGuildId) return;
    return requestInputFocus(inputRef, entryFocusRef.current, () => {
      initialFocusGuildRef.current = selectedGuildId;
    });
  }, [
    selectedGuildId,
    focusReady,
    askAccessAllowed,
    listBusy,
    conversationBusy,
    listMode,
    activeId,
    activeConversation,
    isCreatingNew,
    highlightedMessageId,
    inputRef,
  ]);

  useEffect(() => {
    resetOnGuildChange({
      selectedGuildId,
      askAccessAllowed,
      setOptimisticMessages,
      setOptimisticConversation,
      setIsCreatingNew,
    });
  }, [
    selectedGuildId,
    askAccessAllowed,
    setOptimisticMessages,
    setOptimisticConversation,
    setIsCreatingNew,
  ]);

  useEffect(() => {
    const previousListMode = previousListModeRef.current;
    applyListModeGuards({
      listMode,
      sharingEnabled,
      activeId,
      isCreatingNew,
      newConversationRequested,
      navigateToConversation,
      setIsCreatingNew,
      previousListMode,
    });
  }, [
    listMode,
    sharingEnabled,
    activeId,
    isCreatingNew,
    navigateToConversation,
    newConversationRequested,
    setIsCreatingNew,
  ]);

  useEffect(() => {
    previousListModeRef.current = listMode;
  }, [listMode]);

  useEffect(() => {
    syncActiveConversation({
      selectedGuildId,
      askAccessAllowed,
      listMode,
      sharingEnabled,
      listBusy,
      conversationBusy,
      isCreatingNew,
      listIds,
      activeId,
      sharedConversations,
      activeConversations,
      archivedConversations,
      activeConversation,
      navigateToConversation,
    });
  }, [
    selectedGuildId,
    askAccessAllowed,
    listMode,
    sharingEnabled,
    listBusy,
    conversationBusy,
    isCreatingNew,
    listIds,
    activeId,
    sharedConversations,
    activeConversations,
    archivedConversations,
    activeConversation,
    navigateToConversation,
  ]);

  useEffect(() => {
    if (!newConversationRequested) return;
    if (listMode !== "mine") return;
    setNewConversationRequested(false);
  }, [listMode, newConversationRequested, setNewConversationRequested]);

  useEffect(() => {
    if (!selectedGuildId || !isCreatingNew || listMode !== "mine") return;
    if (!focusReady || !askAccessAllowed || listBusy || conversationBusy)
      return;
    return requestInputFocus(inputRef, newChatFocusRef.current);
  }, [
    isCreatingNew,
    selectedGuildId,
    listMode,
    inputRef,
    focusReady,
    askAccessAllowed,
    listBusy,
    conversationBusy,
  ]);

  useEffect(() => {
    if (!selectedGuildId) return;
    if (listMode !== "mine") return;
    if (
      !focusReady ||
      !askAccessAllowed ||
      listBusy ||
      conversationBusy ||
      activeConversation?.archivedAt ||
      highlightedMessageId
    )
      return;
    if (askPending) return;
    if (!activeId && !isCreatingNew && !activeConversation) return;
    return requestInputFocus(inputRef, entryFocusRef.current);
  }, [
    askPending,
    activeId,
    activeConversation?.id,
    isCreatingNew,
    selectedGuildId,
    listMode,
    inputRef,
    focusReady,
    askAccessAllowed,
    listBusy,
    conversationBusy,
    highlightedMessageId,
    activeConversation?.archivedAt,
  ]);

  useEffect(() => {
    if (activeConversation) {
      setRenameDraft(activeConversation.title);
      setRenaming(false);
      setRenameError(null);
      setArchiveError(null);
    }
  }, [
    activeConversation?.id,
    activeConversation?.title,
    setRenameDraft,
    setRenaming,
    setRenameError,
    setArchiveError,
  ]);

  useEffect(() => {
    if (!optimisticMessages.length) return;
    if (
      activeMessages.some(
        (message) =>
          message.role === "user" &&
          message.text === optimisticMessages[0].text,
      )
    ) {
      setOptimisticMessages([]);
      setOptimisticConversation(null);
    }
  }, [
    activeMessages,
    optimisticMessages,
    setOptimisticMessages,
    setOptimisticConversation,
  ]);

  const followingBottom = useRef(true);
  const previousMessageCount = useRef(displayMessagesLength);
  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    followingBottom.current = true;
    let previousTop = viewport.scrollTop;
    const trackPosition = () => {
      if (viewport.scrollTop < previousTop) followingBottom.current = false;
      if (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        32
      )
        followingBottom.current = true;
      previousTop = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", trackPosition, { passive: true });
    return () => viewport.removeEventListener("scroll", trackPosition);
  }, [chatViewportRef, selectedGuildId, activeId]);

  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    if (previousMessageCount.current !== displayMessagesLength)
      followingBottom.current = true;
    previousMessageCount.current = displayMessagesLength;
    if (!followingBottom.current) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: askPending ? "smooth" : "auto",
    });
  }, [displayMessagesLength, streamContentLength, askPending, chatViewportRef]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = document.querySelector(
      `[data-message-id="${highlightedMessageId}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [displayMessagesLength, highlightedMessageId]);
};
