import {
  ActionIcon,
  Badge,
  Button,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconMessage,
  IconPlus,
  IconSearch,
  IconUsers,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import type {
  AskConversation,
  AskSharedConversation,
} from "../../../types/ask";
import { formatUpdated, type ListMode } from "../../utils/askLinks";
import { uiColors, uiEffects, uiSpacing } from "../../uiTokens";

type ConversationListPanelProps = {
  listMode: ListMode;
  onListModeChange: (mode: ListMode) => void;
  query: string;
  onQueryChange: (value: string) => void;
  mineConversations: AskConversation[];
  archivedConversations: AskConversation[];
  sharedConversations: AskSharedConversation[];
  listBusy: boolean;
  listError: unknown;
  activeId: string | null;
  onNewConversation: () => void;
  navigateToConversation: (
    conversationId: string | null,
    mode: ListMode,
  ) => void;
  sharingEnabled: boolean;
  askAccessAllowed: boolean;
};

export function ConversationListPanel(props: ConversationListPanelProps) {
  const {
    listMode,
    onListModeChange,
    query,
    onQueryChange,
    mineConversations,
    archivedConversations,
    sharedConversations,
    listBusy,
    listError,
    activeId,
    onNewConversation,
    navigateToConversation,
    sharingEnabled,
    askAccessAllowed,
  } = props;

  const listItems =
    listMode === "shared"
      ? sharedConversations
      : listMode === "archived"
        ? archivedConversations
        : mineConversations;
  const emptyTone = listMode === "archived" ? "default" : "soft";

  return (
    <Surface
      p="md"
      withBorder
      style={{
        position: "relative",
        height: "100%",
        maxHeight: "100%",
      }}
    >
      <Stack gap="md" style={{ height: "100%", maxHeight: "100%" }}>
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm" align="center">
            <Surface
              p="sm"
              radius="md"
              tone="soft"
              style={{
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconMessage size={18} />
            </Surface>
            <Stack gap={2} style={{ lineHeight: 1 }}>
              <Text fw={700}>Ask Chronote</Text>
              <Text size="xs" c="dimmed">
                Search meeting knowledge
              </Text>
            </Stack>
          </Group>
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={onNewConversation}
            disabled={!askAccessAllowed}
            data-testid="ask-new"
          >
            New chat
          </Button>
        </Group>
        <SegmentedControl
          fullWidth
          value={listMode}
          onChange={(value) =>
            onListModeChange(
              value === "shared"
                ? "shared"
                : value === "archived"
                  ? "archived"
                  : "mine",
            )
          }
          data-testid="ask-list-mode"
          data={[
            { label: "My chats", value: "mine" },
            { label: "Shared", value: "shared", disabled: !sharingEnabled },
            { label: "Archived", value: "archived" },
          ]}
        />
        <TextInput
          placeholder="Search chats"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          data-testid="ask-search"
        />
        <ScrollArea
          style={{ flex: 1 }}
          offsetScrollbars
          type="always"
          scrollbarSize={10}
          data-visual-scroll
          data-testid="ask-list"
          styles={{
            viewport: {
              paddingRight: `var(--mantine-spacing-${uiSpacing.scrollAreaGutter})`,
            },
          }}
        >
          <Stack gap="xs">
            {listError ? (
              <Surface p="sm" tone="soft">
                <Text size="sm" c="red">
                  Unable to load conversations.
                </Text>
              </Surface>
            ) : listBusy && listItems.length === 0 ? (
              <Surface
                p="lg"
                tone="soft"
                style={{ textAlign: "center" }}
                data-testid="ask-list-loading"
              >
                <Text size="sm" c="dimmed">
                  Loading conversations...
                </Text>
              </Surface>
            ) : listItems.length === 0 ? (
              <Surface p="lg" tone={emptyTone} style={{ textAlign: "center" }}>
                <Stack gap={4}>
                  <Text size="sm" c="dimmed">
                    {listMode === "shared"
                      ? "No shared conversations yet."
                      : listMode === "archived"
                        ? "No archived conversations yet."
                        : "Start by asking about a meeting."}
                  </Text>
                  {listMode === "shared" ? (
                    <Text size="xs" c="dimmed">
                      Sharing is {sharingEnabled ? "available" : "disabled"}.
                    </Text>
                  ) : null}
                </Stack>
              </Surface>
            ) : (
              listItems.map((conv) => {
                const convId =
                  "conversationId" in conv ? conv.conversationId : conv.id;
                const isActive = convId === activeId;
                const displayVisibility =
                  "visibility" in conv
                    ? (conv.visibility ?? "private")
                    : "shared";
                const isArchived =
                  "archivedAt" in conv ? Boolean(conv.archivedAt) : false;
                return (
                  <Surface
                    key={convId}
                    p="sm"
                    withBorder
                    data-testid="ask-conversation-item"
                    data-conversation-id={convId}
                    style={{
                      cursor: "pointer",
                      boxShadow: isActive ? uiEffects.activeInset : undefined,
                      borderColor: isActive
                        ? uiColors.highlightBorderSoft
                        : undefined,
                    }}
                    onClick={() => {
                      navigateToConversation(convId, listMode);
                    }}
                  >
                    <Stack gap={6}>
                      <Group justify="space-between" align="center">
                        <Text fw={600}>{conv.title}</Text>
                        {listMode === "mine" ? (
                          <Text size="xs" c="dimmed" fw={600}>
                            {formatUpdated(conv.updatedAt)}
                          </Text>
                        ) : null}
                      </Group>
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {conv.summary || "Ask Chronote about a meeting."}
                      </Text>
                      {listMode === "mine" ? (
                        displayVisibility !== "private" ? (
                          <Badge
                            size="xs"
                            variant="light"
                            color={
                              displayVisibility === "public" ? "teal" : "cyan"
                            }
                          >
                            {displayVisibility === "public"
                              ? "Public"
                              : "Shared"}
                          </Badge>
                        ) : null
                      ) : listMode === "shared" ? (
                        <Group gap="xs" align="center">
                          <IconUsers size={14} color={uiColors.linkAccent} />
                          <Text size="xs" c="dimmed">
                            {(conv as AskSharedConversation).ownerTag ??
                              "Unknown member"}
                          </Text>
                        </Group>
                      ) : null}
                      {listMode === "archived" || isArchived ? (
                        <Badge size="xs" variant="light" color="gray">
                          Archived
                        </Badge>
                      ) : null}
                    </Stack>
                  </Surface>
                );
              })
            )}
          </Stack>
        </ScrollArea>
      </Stack>
      <ActionIcon
        variant="light"
        color="gray"
        style={{ display: "none" }}
        aria-hidden
        // Placeholder to keep overlay space parity with original layout
      />
      <ActionIcon
        variant="transparent"
        aria-hidden
        style={{ display: "none" }}
      />
      {/* Loading overlay retained for parity */}
      <div>
        <ActionIcon
          variant="transparent"
          aria-hidden
          style={{ display: "none" }}
        />
      </div>
      {/* Mantine LoadingOverlay not needed here; parent handles */}
    </Surface>
  );
}
