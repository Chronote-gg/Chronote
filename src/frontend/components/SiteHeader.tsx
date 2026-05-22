import {
  ActionIcon,
  Box,
  Button,
  Container,
  Group,
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
  IconSwitchHorizontal,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import SiteHeaderLogo from "./SiteHeaderLogo";
import { useAuth } from "../contexts/AuthContext";

type SiteHeaderProps = {
  showNavbarToggle?: boolean;
  navbarOpened: boolean;
  onNavbarToggle: () => void;
  context?: "marketing" | "portal" | "portal-select";
};

type AuthState = ReturnType<typeof useAuth>["state"];
type AuthUser = ReturnType<typeof useAuth>["user"];

type AdminCtaProps = {
  isSuperAdmin: boolean;
  isMobile: boolean;
};

function AdminCta({ isSuperAdmin, isMobile }: AdminCtaProps) {
  if (!isSuperAdmin) return null;
  return (
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
  );
}

type PortalCtaProps = {
  showPortalCta: boolean;
  authState: AuthState;
  portalLabel: string;
  portalPath: string;
  loginUrl: string;
  loading: boolean;
  isMobile: boolean;
};

function PortalCtaButton({
  showPortalCta,
  authState,
  portalLabel,
  portalPath,
  loginUrl,
  loading,
  isMobile,
}: PortalCtaProps) {
  if (!showPortalCta) return null;
  const sharedProps = {
    variant: "light" as const,
    color: "brand" as const,
    size: isMobile ? "xs" : "sm",
    "data-testid": "portal-cta",
  };
  if (authState === "authenticated") {
    return (
      <Button component={Link} to={portalPath} {...sharedProps}>
        {portalLabel}
      </Button>
    );
  }
  return (
    <Button component="a" href={loginUrl} disabled={loading} {...sharedProps}>
      {portalLabel}
    </Button>
  );
}

type LogoutButtonProps = {
  authState: AuthState;
  user: AuthUser;
  logoutUrl: string;
};

function LogoutButton({ authState, user, logoutUrl }: LogoutButtonProps) {
  if (authState !== "authenticated") return null;
  const displayName = user?.username?.trim();
  const tooltipLabel = displayName
    ? `Signed in as ${displayName}`
    : "Switch account";
  return (
    <Tooltip label={tooltipLabel}>
      <ActionIcon
        component="a"
        href={logoutUrl}
        variant="outline"
        size="lg"
        aria-label="Switch account"
        data-testid="logout-cta"
      >
        <IconSwitchHorizontal size={18} />
      </ActionIcon>
    </Tooltip>
  );
}

type GithubLinkProps = {
  showGithubLink: boolean;
};

function GithubLink({ showGithubLink }: GithubLinkProps) {
  if (!showGithubLink) return null;
  return (
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
  );
}

type ThemeToggleProps = {
  isDark: boolean;
  onToggle: () => void;
};

function ThemeToggle({ isDark, onToggle }: ThemeToggleProps) {
  return (
    <Tooltip label={isDark ? "Switch to light mode" : "Switch to dark mode"}>
      <ActionIcon
        variant="outline"
        size="lg"
        onClick={onToggle}
        aria-label="Toggle color scheme"
        data-testid="theme-toggle"
      >
        {isDark ? <IconSun size={18} /> : <IconMoonStars size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

type HeaderActionsProps = {
  isSuperAdmin: boolean;
  showPortalCta: boolean;
  authState: AuthState;
  portalLabel: string;
  portalPath: string;
  loginUrl: string;
  loading: boolean;
  user: AuthUser;
  logoutUrl: string;
  showGithubLink: boolean;
  isMobile: boolean;
  isDark: boolean;
  onToggleTheme: () => void;
};

function HeaderActions({
  isSuperAdmin,
  showPortalCta,
  authState,
  portalLabel,
  portalPath,
  loginUrl,
  loading,
  user,
  logoutUrl,
  showGithubLink,
  isMobile,
  isDark,
  onToggleTheme,
}: HeaderActionsProps) {
  return (
    <Group gap="sm" align="center" wrap="nowrap">
      <AdminCta isSuperAdmin={isSuperAdmin} isMobile={isMobile} />
      <PortalCtaButton
        showPortalCta={showPortalCta}
        authState={authState}
        portalLabel={portalLabel}
        portalPath={portalPath}
        loginUrl={loginUrl}
        loading={loading}
        isMobile={isMobile}
      />
      <LogoutButton authState={authState} user={user} logoutUrl={logoutUrl} />
      <GithubLink showGithubLink={showGithubLink} />
      <ThemeToggle isDark={isDark} onToggle={onToggleTheme} />
    </Group>
  );
}

type PortalHeaderShellProps = {
  showNavbarToggle: boolean;
  navbarOpened: boolean;
  onNavbarToggle: () => void;
  logo: ReactNode;
  rightControls: ReactNode;
  headerPaddingRight: string;
};

function PortalHeaderShell({
  showNavbarToggle,
  navbarOpened,
  onNavbarToggle,
  logo,
  rightControls,
  headerPaddingRight,
}: PortalHeaderShellProps) {
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
      <Box style={{ justifySelf: "end", paddingRight: headerPaddingRight }}>
        {rightControls}
      </Box>
    </Box>
  );
}

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
  const { state: authState, loginUrl, logoutUrl, loading, user } = useAuth();

  const showPortalCta = context !== "portal-select";
  const showGithubLink = true;
  const isPortalLayout = context !== "marketing";
  const portalLabel =
    authState === "authenticated" && context === "portal"
      ? "Switch server"
      : "Open portal";
  const portalPath = context === "portal" ? "/portal/select-server" : "/portal";
  const isSuperAdmin =
    authState === "authenticated" && Boolean(user?.isSuperAdmin);
  const headerPaddingRight = isMobile ? theme.spacing.xs : theme.spacing.sm;

  const logo = <SiteHeaderLogo isMobile={isMobile} isDark={isDark} />;
  const rightControls = (
    <HeaderActions
      isSuperAdmin={isSuperAdmin}
      showPortalCta={showPortalCta}
      authState={authState}
      portalLabel={portalLabel}
      portalPath={portalPath}
      loginUrl={loginUrl}
      loading={loading}
      user={user}
      logoutUrl={logoutUrl}
      showGithubLink={showGithubLink}
      isMobile={isMobile}
      isDark={isDark}
      onToggleTheme={toggleColorScheme}
    />
  );

  if (isPortalLayout) {
    return (
      <PortalHeaderShell
        showNavbarToggle={showNavbarToggle}
        navbarOpened={navbarOpened}
        onNavbarToggle={onNavbarToggle}
        logo={logo}
        rightControls={rightControls}
        headerPaddingRight={headerPaddingRight}
      />
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
