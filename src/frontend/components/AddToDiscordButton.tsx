import { Button, type ButtonProps } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { track } from "../services/analytics";
import { DISCORD_BOT_INVITE_URL } from "../utils/discordInvite";

type AddToDiscordButtonProps = {
  /** Where on the page the click came from, recorded with the event. */
  location: string;
  size?: ButtonProps["size"];
  testId?: string;
};

export function AddToDiscordButton({
  location,
  size = "lg",
  testId,
}: AddToDiscordButtonProps) {
  return (
    <Button
      component="a"
      href={DISCORD_BOT_INVITE_URL}
      size={size}
      radius="md"
      fw={600}
      data-testid={testId}
      rightSection={<IconArrowRight size={18} />}
      onClick={() => track("add_to_discord_clicked", { location })}
    >
      Add to Discord
    </Button>
  );
}

export default AddToDiscordButton;
