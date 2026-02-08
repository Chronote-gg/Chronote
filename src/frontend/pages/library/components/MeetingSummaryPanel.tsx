import type { CSSProperties, HTMLAttributes } from "react";
import {
  ActionIcon,
  Box,
  Divider,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconCopy,
  IconNote,
  IconPencil,
  IconSparkles,
  IconThumbDown,
  IconThumbUp,
} from "@tabler/icons-react";
import MarkdownBody from "../../../components/MarkdownBody";
import Surface from "../../../components/Surface";
import { uiSpacing } from "../../../uiTokens";

type SummaryFeedback = "up" | "down" | null;

type ViewportTestIdProps = HTMLAttributes<HTMLDivElement> & {
  "data-testid": string;
};

const summaryViewportProps: ViewportTestIdProps = {
  "data-testid": "meeting-summary-scroll-viewport",
};

type MeetingSummaryPanelProps = {
  summary: string;
  notes: string;
  summaryFeedback: SummaryFeedback;
  feedbackPending: boolean;
  copyDisabled: boolean;
  scrollable?: boolean;
  onFeedbackUp: () => void;
  onFeedbackDown: () => void;
  onCopySummary: () => void;
  onEditNotes?: () => void;
  onSuggestCorrection?: () => void;
  style?: CSSProperties;
};

export function MeetingSummaryPanel({
  summary,
  notes,
  summaryFeedback,
  feedbackPending,
  copyDisabled,
  scrollable = true,
  onFeedbackUp,
  onFeedbackDown,
  onCopySummary,
  onEditNotes,
  onSuggestCorrection,
  style,
}: MeetingSummaryPanelProps) {
  const panelStyle: CSSProperties = scrollable
    ? {
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }
    : {};
  const summaryBody = (
    <>
      <MarkdownBody content={summary} compact dimmed />
      <Box style={{ position: "relative" }}>
        <Divider my="sm" />
        <Group
          justify="flex-end"
          style={{
            position: "absolute",
            right: 0,
            top: "50%",
            transform: "translateY(-50%)",
          }}
        >
          <Tooltip label="Copy summary">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={onCopySummary}
              disabled={copyDisabled}
              aria-label="Copy summary as Markdown"
              size="sm"
            >
              <IconCopy size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
      <MarkdownBody content={notes} />
    </>
  );
  const summaryContent = <Stack gap="sm">{summaryBody}</Stack>;

  return (
    <Surface
      p="md"
      style={{
        ...panelStyle,
        ...style,
      }}
    >
      <Group
        gap="sm"
        mb="xs"
        justify="space-between"
        align="center"
        wrap="wrap"
      >
        <Group gap="xs">
          <ThemeIcon variant="light" color="brand">
            <IconNote size={16} />
          </ThemeIcon>
          <Text fw={600}>Summary</Text>
        </Group>
        <Group gap="xs" align="center" wrap="wrap">
          <Text size="xs" c="dimmed">
            Was this summary helpful?
          </Text>
          <ActionIcon
            variant={summaryFeedback === "up" ? "light" : "subtle"}
            color={summaryFeedback === "up" ? "teal" : "gray"}
            onClick={onFeedbackUp}
            disabled={feedbackPending}
            aria-label="Mark summary helpful"
          >
            <IconThumbUp size={14} />
          </ActionIcon>
          <ActionIcon
            variant={summaryFeedback === "down" ? "light" : "subtle"}
            color={summaryFeedback === "down" ? "red" : "gray"}
            onClick={onFeedbackDown}
            disabled={feedbackPending}
            aria-label="Mark summary needs work"
          >
            <IconThumbDown size={14} />
          </ActionIcon>
          <Menu withinPortal={false} position="bottom-end">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Notes actions"
                title="Notes actions"
              >
                <IconPencil size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconPencil size={14} />}
                onClick={onEditNotes}
                disabled={!onEditNotes}
              >
                Edit notes
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSparkles size={14} />}
                onClick={onSuggestCorrection}
                disabled={!onSuggestCorrection}
              >
                Suggest correction (AI)
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      {scrollable ? (
        <ScrollArea
          style={{ flex: 1, minHeight: 0 }}
          offsetScrollbars
          type="always"
          scrollbarSize={10}
          data-visual-scroll
          data-testid="meeting-summary-scroll"
          viewportProps={summaryViewportProps}
          styles={{
            viewport: {
              paddingRight: `var(--mantine-spacing-${uiSpacing.scrollAreaGutter})`,
            },
          }}
        >
          {summaryContent}
        </ScrollArea>
      ) : (
        summaryContent
      )}
    </Surface>
  );
}

export default MeetingSummaryPanel;
