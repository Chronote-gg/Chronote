import { MeetingBrowseProvider } from "../contexts/MeetingBrowseContext";
import { meetingBrowseSearchSchema } from "../utils/meetingBrowseSearch";
import {
  AppShell,
  Button,
  Center,
  Container,
  Loader,
  Stack,
  Text,
  type AppShellStylesNames,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import SiteFooter from "../components/SiteFooter";
import SiteHeader from "../components/SiteHeader";
import SiteNavbar from "../components/SiteNavbar";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";
import { useVisualMode } from "../hooks/useVisualMode";
import {
  appBackground,
  pagePaddingX,
  pagePaddingY,
  pagePaddingYCompact,
  portalBackground,
  shellBorder,
  shellFooterBackground,
  shellHeaderBackground,
  shellHeights,
  shellNavbarBackground,
  shellShadow,
} from "../uiTokens";

export default function PortalLayout() {
  const rawSearch = useSearch({ strict: false });

  const [navbarOpened, navbarHandlers] = useDisclosure(false);
  const {
    state: authState,
    loading: authLoading,
    protectedQueriesReady,
    loginUrl,
  } = useAuth();
  const { loading: guildLoading } = useGuildContext();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("dark");
  const isDark = colorScheme === "dark";
  const portalBackgroundImage = portalBackground(isDark);
  const visualMode = useVisualMode();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const browseSearch = meetingBrowseSearchSchema.parse(
    pathname === "/portal/meetings" ? rawSearch : {},
  );
  const showNavbar =
    authState !== "unauthenticated" &&
    !pathname.startsWith("/portal/select-server");
  const desktopNavbar = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`);
  const visualNavbar = showNavbar && desktopNavbar;
  const isServerWorkspace = pathname.startsWith("/portal/server/");
  const navbarWidth = 300;
  const useInnerScroll =
    !visualMode &&
    pathname.startsWith("/portal/server/") &&
    pathname.includes("/ask");
  const headerContext =
    authState === "unauthenticated"
      ? "portal-select"
      : showNavbar
        ? isServerWorkspace
          ? "portal-server"
          : "portal-personal"
        : "portal-select";

  const gridTemplateAreas = visualNavbar
    ? `"header header" "navbar main" "footer footer"`
    : `"header" "main" "footer"`;

  const appShellStyle = {
    height: visualMode ? "auto" : "100vh",
    minHeight: visualMode ? "100vh" : undefined,
    overflow: visualMode ? "visible" : "hidden",
    display: visualMode ? "grid" : undefined,
    gridTemplateColumns: visualMode
      ? visualNavbar
        ? `${navbarWidth}px minmax(0, 1fr)`
        : "minmax(0, 1fr)"
      : undefined,
    gridTemplateRows: visualMode ? "auto 1fr auto" : undefined,
    gridTemplateAreas: visualMode ? gridTemplateAreas : undefined,
    backgroundColor: appBackground(theme, isDark),
    backgroundImage: portalBackgroundImage,
  };

  const baseHeaderStyles = {
    borderBottom: shellBorder(theme, isDark),
    backgroundColor: shellHeaderBackground(isDark),
    backdropFilter: "blur(16px)",
    boxShadow: shellShadow(isDark),
  };

  const baseNavbarStyles = {
    borderRight: shellBorder(theme, isDark),
    backgroundColor: shellNavbarBackground(isDark),
  };

  const baseFooterStyles = {
    borderTop: shellBorder(theme, isDark),
    backgroundColor: shellFooterBackground(isDark),
    backdropFilter: "blur(16px)",
  };

  const appShellStyles: Partial<Record<AppShellStylesNames, CSSProperties>> = {
    header: visualMode
      ? { ...baseHeaderStyles, position: "static", gridArea: "header" }
      : baseHeaderStyles,
    navbar: visualMode
      ? {
          ...baseNavbarStyles,
          position: "static",
          gridArea: "navbar",
          height: "auto",
          transform: "none",
          display: visualNavbar ? undefined : "none",
        }
      : baseNavbarStyles,
    main: visualMode
      ? {
          gridArea: "main",
          minWidth: 0,
          overflow: "visible",
          height: "auto",
          minHeight: "auto",
          paddingTop: 0,
          paddingBottom: 0,
          paddingInlineStart: 0,
          paddingInlineEnd: 0,
        }
      : {
          overflow: useInnerScroll ? "hidden" : "auto",
          height:
            "calc(100dvh - var(--app-shell-header-offset) - var(--app-shell-footer-offset))",
        },
    footer: visualMode
      ? { ...baseFooterStyles, position: "static", gridArea: "footer" }
      : baseFooterStyles,
  };

  if (authState === "unauthenticated") {
    return (
      <AppShell
        padding={0}
        header={{ height: shellHeights.header }}
        footer={{ height: shellHeights.footer }}
        style={appShellStyle}
        styles={appShellStyles}
      >
        <AppShell.Header p="md">
          <SiteHeader
            showNavbarToggle={false}
            navbarOpened={false}
            onNavbarToggle={() => {}}
            context={headerContext}
          />
        </AppShell.Header>
        <AppShell.Main
          data-testid={
            pathname === "/portal/meetings"
              ? "meeting-browse-scroll"
              : undefined
          }
        >
          <Container
            size="xl"
            px={pagePaddingX}
            pt={pagePaddingY}
            pb={pagePaddingY}
            style={{
              display: "block",
              minHeight: 0,
            }}
          >
            <Center py="xl">
              <Stack gap="sm" align="center">
                <Text fw={600}>Connect Discord to open your portal.</Text>
                <Text size="sm" c="dimmed" ta="center">
                  Sign in to open My Meetings and view meeting history.
                </Text>
                <Button
                  component="a"
                  href={loginUrl}
                  loading={authLoading}
                  variant="filled"
                  color="brand"
                >
                  Connect Discord
                </Button>
              </Stack>
            </Center>
          </Container>
        </AppShell.Main>
        <AppShell.Footer>
          <SiteFooter variant="compact" />
        </AppShell.Footer>
      </AppShell>
    );
  }

  if (
    authState === "unknown" ||
    authLoading ||
    !protectedQueriesReady ||
    guildLoading
  ) {
    return (
      <AppShell
        padding={0}
        header={{ height: shellHeights.header }}
        footer={{ height: shellHeights.footer }}
        style={appShellStyle}
        styles={appShellStyles}
      >
        <AppShell.Header p="md">
          <SiteHeader
            showNavbarToggle={false}
            navbarOpened={false}
            onNavbarToggle={() => {}}
            context={headerContext}
          />
        </AppShell.Header>
        <AppShell.Main
          data-testid={
            pathname === "/portal/meetings"
              ? "meeting-browse-scroll"
              : undefined
          }
        >
          <Container
            size="xl"
            px={pagePaddingX}
            pt={pagePaddingY}
            pb={{
              base: useInnerScroll
                ? pagePaddingYCompact.base
                : pagePaddingY.base,
              md: useInnerScroll ? pagePaddingYCompact.md : pagePaddingY.md,
            }}
            style={{
              display: useInnerScroll ? "flex" : "block",
              flexDirection: useInnerScroll ? "column" : undefined,
              minHeight: 0,
              height: useInnerScroll ? "100%" : undefined,
            }}
          >
            <Center py="xl">
              <Stack gap="xs" align="center">
                <Loader color="brand" />
                <Text c="dimmed">Loading your portal...</Text>
              </Stack>
            </Center>
          </Container>
        </AppShell.Main>
        <AppShell.Footer>
          <SiteFooter variant="compact" />
        </AppShell.Footer>
      </AppShell>
    );
  }

  return (
    <MeetingBrowseProvider
      search={browseSearch}
      enabled={pathname === "/portal/meetings"}
    >
      <AppShell
        padding={0}
        header={{ height: shellHeights.header }}
        footer={{ height: shellHeights.footer }}
        style={appShellStyle}
        navbar={
          showNavbar
            ? {
                width: navbarWidth,
                breakpoint: "sm",
                collapsed: { mobile: !navbarOpened },
              }
            : undefined
        }
        styles={appShellStyles}
      >
        <AppShell.Header p="md">
          <SiteHeader
            showNavbarToggle={showNavbar}
            navbarOpened={navbarOpened}
            onNavbarToggle={navbarHandlers.toggle}
            context={headerContext}
          />
        </AppShell.Header>
        {showNavbar ? (
          <AppShell.Navbar p={0}>
            <SiteNavbar onClose={navbarHandlers.close} pathname={pathname} />
          </AppShell.Navbar>
        ) : null}
        <AppShell.Main
          data-testid={
            pathname === "/portal/meetings"
              ? "meeting-browse-scroll"
              : undefined
          }
        >
          <Container
            size="xl"
            px={pagePaddingX}
            pt={pagePaddingY}
            pb={{
              base: useInnerScroll
                ? pagePaddingYCompact.base
                : pagePaddingY.base,
              md: useInnerScroll ? pagePaddingYCompact.md : pagePaddingY.md,
            }}
            style={{
              display: useInnerScroll ? "flex" : "block",
              flexDirection: useInnerScroll ? "column" : undefined,
              minHeight: 0,
              height: useInnerScroll ? "100%" : undefined,
            }}
          >
            <Outlet />
          </Container>
        </AppShell.Main>
        <AppShell.Footer>
          <SiteFooter variant="compact" />
        </AppShell.Footer>
      </AppShell>
    </MeetingBrowseProvider>
  );
}
