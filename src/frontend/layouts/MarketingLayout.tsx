import {
  AppShell,
  Box,
  Container,
  type AppShellStylesNames,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { Outlet } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import SiteFooter from "../components/SiteFooter";
import SiteHeader from "../components/SiteHeader";
import { useVisualMode } from "../hooks/useVisualMode";
import {
  appBackground,
  pagePaddingX,
  shellBorder,
  shellHeaderBackground,
  shellHeights,
  shellShadow,
} from "../uiTokens";

export default function MarketingLayout() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("dark");
  const isDark = colorScheme === "dark";
  const visualMode = useVisualMode();

  const appShellStyle = {
    minHeight: visualMode ? "100vh" : undefined,
    height: visualMode ? "auto" : undefined,
    overflow: visualMode ? "visible" : undefined,
  };

  const appShellStyles: Partial<Record<AppShellStylesNames, CSSProperties>> = {
    header: visualMode
      ? {
          borderBottom: shellBorder(theme, isDark),
          backgroundColor: shellHeaderBackground(isDark),
          backdropFilter: "blur(16px)",
          boxShadow: shellShadow(isDark),
          position: "static",
        }
      : {
          borderBottom: shellBorder(theme, isDark),
          backgroundColor: shellHeaderBackground(isDark),
          backdropFilter: "blur(16px)",
          boxShadow: shellShadow(isDark),
        },
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

  return (
    <AppShell
      padding={0}
      header={{ height: shellHeights.header }}
      style={appShellStyle}
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
        <Box py={{ base: "xl", md: "xl" }}>
          <Container size="xl" px={pagePaddingX}>
            <Outlet />
          </Container>
          <SiteFooter />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
