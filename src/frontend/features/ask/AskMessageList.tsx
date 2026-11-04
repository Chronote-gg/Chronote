import { meetingBrowseSearchSchema } from "../../utils/meetingBrowseSearch";
import { Center, ScrollArea, Stack, Text } from "@mantine/core";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { MouseEvent, RefObject } from "react";
import { useMemo } from "react";
import type { AskMessage } from "../../../types/ask";
import { type ListMode } from "../../utils/askLinks";
import { uiSpacing } from "../../uiTokens";
import { AskMessageBubble } from "./AskMessageBubble";
import type { MarkdownLinkHandler } from "../../components/MarkdownBody";
import {
  buildMeetingLinkForLocation,
  parsePortalMeetingLink,
} from "../../utils/portalLinks";

type AskMessageListProps = {
  askAccessAllowed: boolean;
  listMode: ListMode;
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
  viewportRef: RefObject<HTMLDivElement | null>;
};

const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

const resolvePortalLink = (href: string, serverId: string, origin: string) => {
  const link = parsePortalMeetingLink(href, origin);
  if (!link || link.serverId !== serverId) return null;
  return link;
};

const resolvePortalHref = (href: string, serverId: string, origin: string) => {
  const link = resolvePortalLink(href, serverId, origin);
  if (!link) return href;
  return buildMeetingLinkForLocation({
    pathname: "/portal/meetings",
    search: `?scope=guild&serverId=${encodeURIComponent(link.serverId)}`,
    meetingServerId: link.serverId,
    meetingId: link.meetingId,
    eventId: link.eventId,
  });
};

const shouldOpenPortalLinkInNewTab = (
  href: string,
  serverId: string,
  origin: string,
) => resolvePortalLink(href, serverId, origin) === null;

const handlePortalLinkClick = (options: {
  href: string;
  event: MouseEvent<HTMLAnchorElement>;
  serverId: string;
  origin: string;
  location: Location;
  navigate: ReturnType<typeof useNavigate>;
}) => {
  if (!isPlainLeftClick(options.event)) return;
  const link = resolvePortalLink(
    options.href,
    options.serverId,
    options.origin,
  );
  if (!link) return;
  options.event.preventDefault();
  options.navigate({
    to: "/portal/meetings",
    search: meetingBrowseSearchSchema.parse({
      scope: "guild",
      serverId: link.serverId,
      meetingServerId: link.serverId,
      meetingId: link.meetingId,
      eventId: link.eventId,
    }),
  });
};

const buildPortalLinkHandler = (options: {
  serverId: string;
  origin: string;
  location: Location;
  navigate: ReturnType<typeof useNavigate>;
}): MarkdownLinkHandler => ({
  resolveHref: (href: string) =>
    resolvePortalHref(href, options.serverId, options.origin),
  openInNewTab: (href: string) =>
    shouldOpenPortalLinkInNewTab(href, options.serverId, options.origin),
  onLinkClick: ({ href, event }) =>
    handlePortalLinkClick({
      href,
      event,
      serverId: options.serverId,
      origin: options.origin,
      location: options.location,
      navigate: options.navigate,
    }),
});

export function AskMessageList({
  askAccessAllowed,
  listMode,
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
  viewportRef,
}: AskMessageListProps) {
  const { serverId } = useParams({ from: "/portal/server/$serverId/ask" });
  const navigate = useNavigate({ from: "/portal/server/$serverId/ask" });

  const linkHandler = useMemo<MarkdownLinkHandler | undefined>(() => {
    if (!serverId || typeof window === "undefined") return undefined;
    return buildPortalLinkHandler({
      serverId,
      origin: window.location.origin,
      location: window.location,
      navigate,
    });
  }, [navigate, serverId]);

  return (
    <ScrollArea
      style={{ flex: 1, minHeight: 0 }}
      viewportRef={viewportRef}
      type="always"
      offsetScrollbars
      scrollbarSize={10}
      data-visual-scroll
      data-testid="ask-messages"
      styles={{
        viewport: {
          paddingRight: `var(--mantine-spacing-${uiSpacing.scrollAreaGutter})`,
        },
      }}
    >
      <Stack gap="sm">
        {!askAccessAllowed ? (
          <Center py="lg">
            <Text size="sm" c="dimmed">
              Ask access is disabled for members in this server.
            </Text>
          </Center>
        ) : listMode === "shared" && !sharingEnabled ? (
          <Center py="lg">
            <Text size="sm" c="dimmed">
              Sharing is disabled for this server.
            </Text>
          </Center>
        ) : conversationError ? (
          <Center py="lg">
            <Text size="sm" c="dimmed">
              Conversation unavailable.
            </Text>
          </Center>
        ) : displayMessages.length === 0 ? (
          <Center py="lg">
            <Text size="sm" c="dimmed">
              {listMode === "shared"
                ? "Select a shared conversation to view it."
                : "Start by asking about a recent meeting."}
            </Text>
          </Center>
        ) : (
          displayMessages.map((message) => (
            <AskMessageBubble
              key={message.id}
              message={message}
              roleLabels={{ user: "You", chronote: "Chronote" }}
              highlighted={highlightedMessageId === message.id}
              showActions
              showFeedback={showFeedback}
              feedbackState={feedbackState ? feedbackState(message.id) : null}
              feedbackPending={feedbackPending}
              onFeedbackUp={onFeedbackUp}
              onFeedbackDown={onFeedbackDown}
              linkHandler={linkHandler}
              onCopyLink={onCopyLink}
              onCopyResponse={onCopyResponse}
            />
          ))
        )}
      </Stack>
    </ScrollArea>
  );
}

export type { AskMessageListProps };
