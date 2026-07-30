import { Box, Group } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { uiLinks } from "../uiTokens";
import Wordmark from "./Wordmark";

type SiteHeaderLogoProps = {
  isMobile: boolean;
};

export function SiteHeaderLogo({ isMobile }: SiteHeaderLogoProps) {
  return (
    <Link to="/" style={uiLinks.plain} data-testid="site-logo">
      <Group gap="sm" align="center" wrap="nowrap">
        <Box
          component="img"
          src="/meeting_notes_original_logo.png"
          alt="Chronote logo"
          style={{ width: 40, height: 40 }}
        />
        <Wordmark size={isMobile ? "lg" : "xl"} />
      </Group>
    </Link>
  );
}

export default SiteHeaderLogo;
