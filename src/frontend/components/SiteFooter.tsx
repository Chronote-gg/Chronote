import {
  Anchor,
  Box,
  Container,
  Divider,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { DISCORD_BOT_INVITE_URL } from "../utils/discordInvite";

type SiteFooterProps = {
  variant?: "default" | "compact";
};

export function SiteFooter({ variant = "default" }: SiteFooterProps) {
  const isCompact = variant === "compact";
  const content = (
    <Container size={isCompact ? undefined : "xl"} fluid={isCompact} py="md">
      {isCompact ? (
        <Group justify="center" gap="lg" wrap="wrap">
          <Text size="sm" c="dimmed">
            Chronote by{" "}
            <Anchor
              href="https://basicbit.net/"
              c="inherit"
              target="_blank"
              rel="noreferrer"
            >
              BASICBIT
            </Anchor>
          </Text>
          <Anchor href={DISCORD_BOT_INVITE_URL} size="sm">
            Add to Discord
          </Anchor>
          <Anchor
            href="https://github.com/Chronote-gg/chronote"
            size="sm"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </Anchor>
          <Anchor href="https://chronote.gg" size="sm">
            Docs
          </Anchor>
        </Group>
      ) : (
        <Group justify="space-between" gap="md" wrap="wrap">
          <Text size="sm" c="dimmed">
            Chronote by{" "}
            <Anchor
              href="https://basicbit.net/"
              c="inherit"
              target="_blank"
              rel="noreferrer"
            >
              BASICBIT
            </Anchor>
          </Text>
          <Group gap="lg">
            <Anchor href={DISCORD_BOT_INVITE_URL} size="sm">
              Add to Discord
            </Anchor>
            <Anchor
              href="https://github.com/Chronote-gg/chronote"
              size="sm"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </Anchor>
            <Anchor href="https://chronote.gg" size="sm">
              Docs
            </Anchor>
          </Group>
        </Group>
      )}
    </Container>
  );

  if (variant === "compact") {
    return <Box>{content}</Box>;
  }

  return (
    <Stack gap="md" mt="xl">
      <Divider />
      {content}
    </Stack>
  );
}

export default SiteFooter;
