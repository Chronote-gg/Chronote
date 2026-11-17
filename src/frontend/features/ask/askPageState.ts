import type {
  AskConversation,
  AskConversationVisibility,
  AskMessage,
  AskSharedConversation,
} from "../../../types/ask";
import { buildAskUrl, buildPublicAskUrl } from "../../utils/askLinks";
import type { ListMode } from "../../utils/askLinks";

type QueryStatus = {
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
};

type ConversationQueryData = {
  conversation?: AskConversation;
  messages?: AskMessage[];
};

type SharedConversationQueryData = {
  conversation?: AskConversation;
  messages?: AskMessage[];
  shared?: AskSharedConversation;
};

type ShareUrlResult = {
  serverShareUrl: string;
  publicShareUrl: string;
  shareUrl: string;
};

const pickExistingOrFirst = <T>(
  activeId: string | null,
  items: T[],
  getId: (item: T) => string,
): string | null => {
  if (!activeId) {
    return items[0] ? getId(items[0]) : null;
  }
  const hasActive = items.some((item) => getId(item) === activeId);
  if (hasActive) return activeId;
  return items[0] ? getId(items[0]) : null;
};

export const prependOptimisticConversation = (
  conversations: AskConversation[],
  optimisticConversation: AskConversation | null,
): AskConversation[] =>
  optimisticConversation
    ? [optimisticConversation, ...conversations]
    : conversations;

export const filterConversationsByQuery = <T>(options: {
  query: string;
  source: T[];
  toSearchText: (item: T) => string;
}): T[] => {
  const { query, source, toSearchText } = options;
  if (!query) return source;
  const needle = query.toLowerCase();
  return source.filter((item) =>
    toSearchText(item).toLowerCase().includes(needle),
  );
};

export const resolveListIds = (options: {
  listMode: ListMode;
  activeConversations: AskConversation[];
  archivedConversations: AskConversation[];
  sharedConversations: AskSharedConversation[];
}): string[] => {
  const {
    listMode,
    activeConversations,
    archivedConversations,
    sharedConversations,
  } = options;
  if (listMode === "shared") {
    return sharedConversations.map((conv) => conv.conversationId);
  }
  if (listMode === "archived") {
    return archivedConversations.map((conv) => conv.id);
  }
  return activeConversations.map((conv) => conv.id);
};

export const resolveListState = (options: {
  listMode: ListMode;
  listQuery: QueryStatus;
  sharedListQuery: QueryStatus;
  conversationQuery: QueryStatus;
  sharedConversationQuery: QueryStatus;
}) => {
  const {
    listMode,
    listQuery,
    sharedListQuery,
    conversationQuery,
    sharedConversationQuery,
  } = options;
  const sharedMode = listMode === "shared";
  return {
    listBusy: sharedMode
      ? sharedListQuery.isLoading || sharedListQuery.isFetching
      : listQuery.isLoading || listQuery.isFetching,
    conversationBusy: sharedMode
      ? sharedConversationQuery.isLoading || sharedConversationQuery.isFetching
      : conversationQuery.isLoading || conversationQuery.isFetching,
    listError: sharedMode ? sharedListQuery.error : listQuery.error,
    conversationError: sharedMode
      ? sharedConversationQuery.error
      : conversationQuery.error,
  };
};

export const resolveConversationData = (options: {
  listMode: ListMode;
  isCreatingNew: boolean;
  activeId: string | null;
  conversationData: ConversationQueryData | undefined;
  sharedConversationData: SharedConversationQueryData | undefined;
}): {
  activeConversation: AskConversation | null;
  activeMessages: AskMessage[];
  sharedMeta: AskSharedConversation | null;
} => {
  const {
    listMode,
    isCreatingNew,
    activeId,
    conversationData,
    sharedConversationData,
  } = options;
  if (isCreatingNew || !activeId) {
    return { activeConversation: null, activeMessages: [], sharedMeta: null };
  }
  if (listMode === "shared") {
    return {
      activeConversation: sharedConversationData?.conversation ?? null,
      activeMessages: sharedConversationData?.messages ?? [],
      sharedMeta: sharedConversationData?.shared ?? null,
    };
  }
  return {
    activeConversation: conversationData?.conversation ?? null,
    activeMessages: conversationData?.messages ?? [],
    sharedMeta: null,
  };
};

export const resolveDisplayTitle = (
  activeConversation: AskConversation | null,
  optimisticConversation: AskConversation | null,
): string =>
  activeConversation?.title ?? optimisticConversation?.title ?? "New chat";

export const resolveShareDisplayVisibility = (
  activeVisibility: AskConversationVisibility,
  publicSharingEnabled: boolean,
): AskConversationVisibility =>
  activeVisibility === "public" && !publicSharingEnabled
    ? "server"
    : activeVisibility;

export const resolveShareBadgeLabel = (
  shareDisplayVisibility: AskConversationVisibility,
): "Public" | "Shared" =>
  shareDisplayVisibility === "public" ? "Public" : "Shared";

export const resolveShareActionDisabled = (options: {
  selectedGuildId: string | null;
  activeConversation: AskConversation | null;
  listMode: ListMode;
  isArchived: boolean;
  sharingEnabled: boolean;
  askAccessAllowed: boolean;
}): boolean => {
  const {
    selectedGuildId,
    activeConversation,
    listMode,
    isArchived,
    sharingEnabled,
    askAccessAllowed,
  } = options;
  return Boolean(
    !selectedGuildId ||
    !activeConversation ||
    listMode === "shared" ||
    isArchived ||
    !sharingEnabled ||
    !askAccessAllowed,
  );
};

export const resolveShareUrls = (options: {
  origin: string | null;
  selectedGuildId: string | null;
  activeConversation: AskConversation | null;
  shareDisplayVisibility: AskConversationVisibility;
}): ShareUrlResult => {
  const {
    origin,
    selectedGuildId,
    activeConversation,
    shareDisplayVisibility,
  } = options;
  if (!origin || !selectedGuildId || !activeConversation) {
    return { serverShareUrl: "", publicShareUrl: "", shareUrl: "" };
  }
  const serverShareUrl = buildAskUrl({
    origin,
    serverId: selectedGuildId,
    conversationId: activeConversation.id,
    listMode: "shared",
  });
  const publicShareUrl = buildPublicAskUrl({
    origin,
    serverId: selectedGuildId,
    conversationId: activeConversation.id,
  });
  const shareUrl =
    shareDisplayVisibility === "public" ? publicShareUrl : serverShareUrl;
  return { serverShareUrl, publicShareUrl, shareUrl };
};

export const resolveCanExport = (
  activeConversation: AskConversation | null,
  listMode: ListMode,
): boolean => Boolean(activeConversation && listMode !== "shared");

export const resolveAllowOptimistic = (
  listMode: ListMode,
  isArchived: boolean,
): boolean => listMode === "mine" && !isArchived;

export const resolveNextConversationId = (options: {
  mode: ListMode;
  activeId: string | null;
  activeConversations: AskConversation[];
  archivedConversations: AskConversation[];
  sharedConversations: AskSharedConversation[];
}): string | null => {
  const {
    mode,
    activeId,
    activeConversations,
    archivedConversations,
    sharedConversations,
  } = options;
  if (mode === "shared") {
    return pickExistingOrFirst(
      activeId,
      sharedConversations,
      (conv) => conv.conversationId,
    );
  }
  if (mode === "archived") {
    return pickExistingOrFirst(
      activeId,
      archivedConversations,
      (conv) => conv.id,
    );
  }
  return pickExistingOrFirst(activeId, activeConversations, (conv) => conv.id);
};

export function resolveAskFocusReady(options: {
  ready: boolean;
  listError: unknown;
  shareModalOpen: boolean;
  archiveModalOpen: boolean;
  feedbackModalOpen: boolean;
  pickerOpen: boolean;
}) {
  return Boolean(
    options.ready &&
    !options.listError &&
    !options.shareModalOpen &&
    !options.archiveModalOpen &&
    !options.feedbackModalOpen &&
    !options.pickerOpen,
  );
}
