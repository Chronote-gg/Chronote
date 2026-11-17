import { Divider, LoadingOverlay, Stack } from "@mantine/core";
import type { RefObject, ReactNode } from "react";
import Surface from "../../components/Surface";
import type {
  AskConversation,
  AskConversationVisibility,
  AskMessage,
  AskSharedConversation,
} from "../../../types/ask";
import type { ListMode } from "../../utils/askLinks";
import { uiOverlays } from "../../uiTokens";
import { AskComposer } from "./AskComposer";
import { AskConversationHeader } from "./AskConversationHeader";
import { AskConversationNotices } from "./AskConversationNotices";
import { AskMessageList } from "./AskMessageList";

type AskConversationPaneProps = {
  startingContent?: ReactNode;
  modeNotice?: ReactNode;
  historyDescription?: string;
  contextChips?: ReactNode;
  contextAction?: ReactNode;
  onStop?: () => void;
  activity?: string;
  listBusy: boolean;
  conversationBusy: boolean;
  listMode: ListMode;
  activeConversation: AskConversation | null;
  sharedMeta: AskSharedConversation | null;
  displayTitle: string;
  isShared: boolean;
  shareDisplayVisibility: AskConversationVisibility;
  shareBadgeLabel: string;
  isArchived: boolean;
  shareActionDisabled: boolean;
  canExport: boolean;
  renaming: boolean;
  showRename: boolean;
  renameDraft: string;
  renameError: string | null;
  archiveError: string | null;
  selectedGuildId: string | null;
  renameLoading: boolean;
  archiveLoading: boolean;
  askAccessAllowed: boolean;
  sharingEnabled: boolean;
  conversationError: unknown;
  displayMessages: AskMessage[];
  highlightedMessageId: string | null;
  onCopyLink: (messageId?: string) => void;
  onCopyResponse: (text: string) => void;
  showFeedback?: boolean;
  feedbackState?: (messageId: string) => "up" | "down" | null;
  feedbackPending?: boolean;
  onFeedbackUp?: (messageId: string) => void;
  onFeedbackDown?: (messageId: string) => void;
  chatViewportRef: RefObject<HTMLDivElement | null>;
  draft: string;
  errorMessage: string | null;
  askPending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAsk: () => void;
  onDraftChange: (value: string) => void;
  onRenameDraftChange: (value: string) => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
  onRenameStart: () => void;
  onShareOpen: () => void;
  onArchiveOpen: () => void;
  onNewConversation: () => void;
  onExport: (format: "json" | "text") => void;
};

export function AskConversationPane({
  startingContent,
  modeNotice,
  historyDescription,
  contextChips,
  contextAction,
  onStop,
  activity,
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
  showRename,
  renameDraft,
  renameError,
  archiveError,
  selectedGuildId,
  renameLoading,
  archiveLoading,
  askAccessAllowed,
  sharingEnabled,
  conversationError,
  displayMessages,
  highlightedMessageId,
  onCopyLink,
  onCopyResponse,
  showFeedback = false,
  feedbackState,
  feedbackPending = false,
  onFeedbackUp,
  onFeedbackDown,
  chatViewportRef,
  draft,
  errorMessage,
  askPending,
  inputRef,
  onAsk,
  onDraftChange,
  onRenameDraftChange,
  onRenameSave,
  onRenameCancel,
  onRenameStart,
  onShareOpen,
  onArchiveOpen,
  onNewConversation,
  onExport,
}: AskConversationPaneProps) {
  return (
    <Surface
      p="md"
      style={{
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        maxHeight: "100%",
      }}
      data-testid="ask-pane"
    >
      <LoadingOverlay
        visible={listBusy || conversationBusy}
        data-testid="ask-loading-pane"
        overlayProps={uiOverlays.loading}
        loaderProps={{ size: "md" }}
      />
      <Stack gap="md" style={{ height: "100%", minHeight: 0 }}>
        <AskConversationHeader
          listMode={listMode}
          activeConversation={activeConversation}
          displayTitle={displayTitle}
          isShared={isShared}
          shareDisplayVisibility={shareDisplayVisibility}
          shareBadgeLabel={shareBadgeLabel}
          isArchived={isArchived}
          shareActionDisabled={shareActionDisabled}
          canExport={canExport}
          renaming={renaming}
          showRename={showRename}
          renameDraft={renameDraft}
          selectedGuildId={selectedGuildId}
          renameLoading={renameLoading}
          archiveLoading={archiveLoading}
          onRenameDraftChange={onRenameDraftChange}
          onRenameSave={onRenameSave}
          onRenameCancel={onRenameCancel}
          onRenameStart={onRenameStart}
          onShareOpen={onShareOpen}
          onArchiveOpen={onArchiveOpen}
          onExport={onExport}
        />
        <AskConversationNotices
          listMode={listMode}
          sharedMeta={sharedMeta}
          isShared={isShared}
          sharingEnabled={sharingEnabled}
          renameError={renameError}
          archiveError={archiveError}
          activeConversation={activeConversation}
          isArchived={isArchived}
          onNewConversation={onNewConversation}
        />
        {modeNotice}
        <Divider />
        <AskMessageList
          emptyContent={startingContent}
          askAccessAllowed={askAccessAllowed}
          listMode={listMode}
          sharingEnabled={sharingEnabled}
          conversationError={conversationError}
          displayMessages={displayMessages}
          highlightedMessageId={highlightedMessageId}
          onCopyLink={onCopyLink}
          onCopyResponse={onCopyResponse}
          showFeedback={showFeedback}
          feedbackState={feedbackState}
          feedbackPending={feedbackPending}
          onFeedbackUp={onFeedbackUp}
          onFeedbackDown={onFeedbackDown}
          viewportRef={chatViewportRef}
        />
        <Divider />
        <AskComposer
          contextChips={contextChips}
          historyDescription={historyDescription}
          contextAction={contextAction}
          onStop={onStop}
          activity={activity}
          listMode={listMode}
          isArchived={isArchived}
          askAccessAllowed={askAccessAllowed}
          selectedGuildId={selectedGuildId}
          draft={draft}
          onDraftChange={onDraftChange}
          onAsk={onAsk}
          askPending={askPending}
          errorMessage={errorMessage}
          inputRef={inputRef}
        />
      </Stack>
    </Surface>
  );
}

export type { AskConversationPaneProps };
