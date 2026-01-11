import {
  ActionIcon,
  Box,
  Button,
  Container,
  Group,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconMenu2,
  IconMoonStars,
  IconSun,
  IconBrandGithub,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { uiLinks, uiTypography } from "../uiTokens";

type SiteHeaderProps = {
  showNavbarToggle?: boolean;
  navbarOpened: boolean;
  onNavbarToggle: () => void;
  context?: "marketing" | "portal" | "portal-select";
};

export function SiteHeader({
  showNavbarToggle = true,
  navbarOpened,
  onNavbarToggle,
  context = "marketing",
}: SiteHeaderProps) {
  const theme = useMantineTheme();
  const isMobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm})`);
  const { toggleColorScheme } = useMantineColorScheme({
    keepTransitions: true,
  });
  const computedScheme = useComputedColorScheme("dark");
  const isDark = computedScheme === "dark";
  const { state: authState, loginUrl, loading, user } = useAuth();

  const showPortalCta = context !== "portal-select";
  const showGithubLink = true;
  const isPortalLayout = context !== "marketing";
  const portalLabel =
    authState === "authenticated" && context === "portal"
      ? "Switch server"
      : "Open portal";
  const isSuperAdmin = authState === "authenticated" && user?.isSuperAdmin;

  const logo = (
    <Link to="/" style={uiLinks.plain} data-testid="site-logo">
      <Group gap="sm" align="center" wrap="nowrap">
        <Box
          component="img"
          src="/meeting_notes_original_logo.png"
          alt="Chronote logo"
          style={{ width: 40, height: 40 }}
        />
        <Text
          size={isMobile ? "lg" : "xl"}
          c={isDark ? "white" : "dark.9"}
          style={uiTypography.logo}
        >
          Chronote
        </Text>
      </Group>
    </Link>
  );

  const rightControls = (
    <Group gap="sm" align="center" wrap="nowrap">
      {isSuperAdmin ? (
        <Button
          component={Link}
          to="/admin"
          variant="outline"
          color="gray"
          size={isMobile ? "xs" : "sm"}
          data-testid="admin-cta"
        >
          Admin
        </Button>
      ) : null}
      {showPortalCta ? (
        authState === "authenticated" ? (
          <Button
            component={Link}
            to="/portal/select-server"
            variant="light"
            color="brand"
            size={isMobile ? "xs" : "sm"}
            data-testid="portal-cta"
          >
            {portalLabel}
          </Button>
        ) : (
          <Button
            component="a"
            href={loginUrl}
            variant="light"
            color="brand"
            size={isMobile ? "xs" : "sm"}
            disabled={loading}
            data-testid="portal-cta"
          >
            {portalLabel}
          </Button>
        )
      ) : null}
      {showGithubLink ? (
        <Tooltip label="GitHub">
          <ActionIcon
            component="a"
            href="https://github.com/Chronote-gg/chronote"
            target="_blank"
            rel="noreferrer"
            variant="outline"
            size="lg"
            aria-label="GitHub repository"
          >
            <IconBrandGithub size={18} />
          </ActionIcon>
        </Tooltip>
      ) : null}
      <Tooltip label={isDark ? "Switch to light mode" : "Switch to dark mode"}>
        <ActionIcon
          variant="outline"
          size="lg"
          onClick={() => toggleColorScheme()}
          aria-label="Toggle color scheme"
          data-testid="theme-toggle"
        >
          {isDark ? <IconSun size={18} /> : <IconMoonStars size={18} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  if (isPortalLayout) {
    return (
      <Box
        h="100%"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
          alignItems: "center",
        }}
      >
        <Box>
          {showNavbarToggle ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              onClick={onNavbarToggle}
              hiddenFrom="sm"
              aria-label={navbarOpened ? "Close navigation" : "Open navigation"}
            >
              <IconMenu2 size={18} />
            </ActionIcon>
          ) : null}
        </Box>
        <Box style={{ justifySelf: "center" }}>{logo}</Box>
        <Box
          style={{
            justifySelf: "end",
            paddingRight: isMobile ? theme.spacing.xs : theme.spacing.sm,
          }}
        >
          {rightControls}
        </Box>
      </Box>
    );
  }

  return (
    <Container size="xl" h="100%">
      <Group h="100%" justify="space-between" wrap="nowrap">
        {logo}
        {rightControls}
      </Group>
    </Container>
  );
}

export default SiteHeader;
