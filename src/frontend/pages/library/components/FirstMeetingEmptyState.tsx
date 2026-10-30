import { Box, Button, Code, Stack, Text, Title } from "@mantine/core";
import { IconBrandDiscord } from "@tabler/icons-react";
import SampleSummary from "../../../components/SampleSummary";
import Surface from "../../../components/Surface";
import classes from "./FirstMeetingEmptyState.module.css";

export function FirstMeetingEmptyState({
  discordUrl,
  serverName,
  optionalSetupUrl,
}: {
  discordUrl: string;
  optionalSetupUrl?: string;
  serverName?: string;
}): React.JSX.Element {
  return (
    <Surface
      p="lg"
      className={classes.root}
      data-testid="first-meeting-empty-state"
    >
      <Stack gap="xl">
        <div className={classes.content}>
          <Stack gap="lg" align="flex-start">
            <Stack gap="xs">
              <Title order={2}>
                {serverName
                  ? `Your first meeting in ${serverName} goes here.`
                  : "Your first meeting goes here."}
              </Title>
              <Text c="dimmed">
                Record a conversation in Discord. Your notes will be saved here.
              </Text>
            </Stack>
            <ol className={classes.steps}>
              <li>
                <Text fw={600}>Join a voice channel.</Text>
                <Text size="sm" c="dimmed">
                  Head to your server and join the conversation.
                </Text>
              </li>
              <li>
                <Text fw={600}>Start recording.</Text>
                <Text size="sm" c="dimmed">
                  Run <Code>/startmeeting</Code> in a text channel.
                </Text>
              </li>
              <li>
                <Text fw={600}>End the recording.</Text>
                <Text size="sm" c="dimmed">
                  Use <strong>End meeting</strong> when you're done. Chronote
                  takes care of the notes.
                </Text>
              </li>
            </ol>
            <Button
              component="a"
              href={discordUrl}
              leftSection={<IconBrandDiscord size={18} />}
            >
              Open Discord
            </Button>
            <Text size="sm" c="dimmed">
              Chronote's private reply links to your recording controls and
              notes channel.
            </Text>
          </Stack>
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Example notes · Fictional meeting
            </Text>
            <SampleSummary />
          </Stack>
        </div>
        <Box component="details">
          <Text
            component="summary"
            fw={600}
            size="sm"
            style={{ cursor: "pointer" }}
          >
            Optional setup
          </Text>
          <Text size="sm" c="dimmed" mt="sm">
            Use <Code>/context</Code> for background and{" "}
            <Code>/autorecord</Code> for automatic recording.
          </Text>
          {optionalSetupUrl ? (
            <Text component="a" href={optionalSetupUrl} size="sm">
              Read about optional setup
            </Text>
          ) : null}
        </Box>
      </Stack>
    </Surface>
  );
}
