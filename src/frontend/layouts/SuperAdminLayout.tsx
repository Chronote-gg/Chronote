import {
  AppShell,
  Box,
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
import { Outlet } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import SiteFooter from "../components/SiteFooter";
import SiteHeader from "../components/SiteHeader";
import { useAuth } from "../contexts/AuthContext";
import { useVisualMode } from "../hooks/useVisualMode";
import {
  appBackground,
  pagePaddingX,
  pagePaddingY,
  portalBackground,
  shellBorder,
  shellFooterBackground,
  shellHeaderBackground,
  shellHeights,
  shellShadow,
} from "../uiTokens";

export default function SuperAdminLayout() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("dark");
  const isDark = colorScheme === "dark";
  const visualMode = useVisualMode();
  const { state: authState, loading: authLoading, loginUrl } = useAuth();

  const baseHeaderStyles = {
    borderBottom: shellBorder(theme, isDark),
    backgroundColor: shellHeaderBackground(isDark),
    backdropFilter: "blur(16px)",
    boxShadow: shellShadow(isDark),
  };

  const baseFooterStyles = {
    borderTop: shellBorder(theme, isDark),
    backgroundColor: shellFooterBackground(isDark),
    backdropFilter: "blur(16px)",
  };

  const appShellStyles: Partial<Record<AppShellStylesNames, CSSProperties>> = {
    header: visualMode
      ? { ...baseHeaderStyles, position: "static" }
      : baseHeaderStyles,
    footer: visualMode
      ? { ...baseFooterStyles, position: "static" }
      : baseFooterStyles,
    main: visualMode
      ? {
          backgroundColor: appBackground(theme, isDark),
          paddingTop: 0,
          paddingBottom: 0,
          paddingInlineStart: 0,
          paddingInlineEnd: 0,
          minHeight: "auto",
          height: "auto",
          overflow: "visible",
        }
      : {
          backgroundColor: appBackground(theme, isDark),
        },
  };

  const content =
    authState === "unauthenticated" ? (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text fw={600}>Connect Discord to access the admin console.</Text>
          <Text size="sm" c="dimmed" ta="center">
            You need super admin access to manage global settings.
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
    ) : authState === "unknown" || authLoading ? (
      <Center py="xl">
        <Stack gap="xs" align="center">
          <Loader color="brand" />
          <Text c="dimmed">Loading admin console...</Text>
        </Stack>
      </Center>
    ) : (
      <Outlet />
    );

  return (
    <AppShell
      padding={0}
      header={{ height: shellHeights.header }}
      footer={{ height: shellHeights.footer }}
      styles={appShellStyles}
    >
      <AppShell.Header p="md">
        <SiteHeader
          showNavbarToggle={false}
          navbarOpened={false}
          onNavbarToggle={() => {}}
          context="marketing"
        />
      </AppShell.Header>
      <AppShell.Main>
        <Box
          py={pagePaddingY}
          style={{
            backgroundImage: portalBackground(isDark),
            minHeight: "100%",
          }}
        >
          <Container size="xl" px={pagePaddingX}>
            {content}
          </Container>
        </Box>
      </AppShell.Main>
      <AppShell.Footer>
        <SiteFooter variant="compact" />
      </AppShell.Footer>
    </AppShell>
  );
}
