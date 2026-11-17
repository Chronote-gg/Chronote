import { Button, Drawer, Grid, Stack } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import PageHeader from "../../components/PageHeader";
import { ConversationListPanel } from "./ConversationListPanel";
import type {
  AskConversation,
  AskSharedConversation,
} from "../../../types/ask";
import type { ListMode } from "../../utils/askLinks";
import { AskArchiveModal, type AskArchiveModalProps } from "./AskArchiveModal";
import {
  AskConversationPane,
  type AskConversationPaneProps,
} from "./AskConversationPane";
import { AskShareModal, type AskShareModalProps } from "./AskShareModal";

type AskPageLayoutProps = {
  shareModalProps: AskShareModalProps;
  archiveModalProps: AskArchiveModalProps;
  listMode: ListMode;
  query: string;
  onQueryChange: (value: string) => void;
  mineConversations: AskConversation[];
  archivedConversations: AskConversation[];
  sharedConversations: AskSharedConversation[];
  listBusy: boolean;
  listError: unknown;
  activeId: string | null;
  onNewConversation: () => void;
  onNavigateConversation: (
    conversationId: string | null,
    mode: ListMode,
  ) => void;
  onListModeChange: (mode: ListMode) => void;
  sharingEnabled: boolean;
  askAccessAllowed: boolean;
  conversationPaneProps: AskConversationPaneProps;
};

export function AskPageLayout({
  shareModalProps,
  archiveModalProps,
  listMode,
  query,
  onQueryChange,
  mineConversations,
  archivedConversations,
  sharedConversations,
  listBusy,
  listError,
  activeId,
  onNewConversation,
  onNavigateConversation,
  onListModeChange,
  sharingEnabled,
  askAccessAllowed,
  conversationPaneProps,
}: AskPageLayoutProps) {
  const desktop = useMediaQuery("(min-width: 62em)");
  const [chatsOpened, chats] = useDisclosure(false);
  const conversationList = (
    <ConversationListPanel
      listMode={listMode}
      onListModeChange={onListModeChange}
      query={query}
      onQueryChange={onQueryChange}
      mineConversations={mineConversations}
      archivedConversations={archivedConversations}
      sharedConversations={sharedConversations}
      listBusy={listBusy}
      listError={listError}
      activeId={activeId}
      onNewConversation={() => {
        chats.close();
        onNewConversation();
      }}
      navigateToConversation={(id, mode) => {
        chats.close();
        onNavigateConversation(id, mode);
      }}
      sharingEnabled={sharingEnabled}
      askAccessAllowed={askAccessAllowed}
    />
  );
  return (
    <Stack
      gap="md"
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      data-testid="ask-page"
    >
      <PageHeader
        title="Ask"
        description="Ask about accessible meetings with links back to your notes. Conversations stay scoped to the selected server."
      />

      <AskShareModal {...shareModalProps} />
      <AskArchiveModal {...archiveModalProps} />
      {!desktop ? (
        <>
          <Button variant="light" size="xs" onClick={chats.open}>
            Chats
          </Button>
          <Drawer opened={chatsOpened} onClose={chats.close} title="Chats">
            <div
              style={{
                height: "calc(100dvh - 100px)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {conversationList}
            </div>
          </Drawer>
        </>
      ) : null}

      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Grid
          gap="lg"
          style={{ flex: 1, minHeight: 0, height: "100%" }}
          align="stretch"
          styles={{ inner: { height: "100%" } }}
        >
          {desktop ? (
            <Grid.Col span={4} style={{ height: "100%" }}>
              {conversationList}
            </Grid.Col>
          ) : null}
          <Grid.Col
            span={{ base: 12, md: 8 }}
            style={{
              display: "flex",
              minHeight: 0,
              height: "100%",
              maxHeight: "100%",
            }}
          >
            <AskConversationPane {...conversationPaneProps} />
          </Grid.Col>
        </Grid>
      </div>
    </Stack>
  );
}

export type { AskPageLayoutProps };
