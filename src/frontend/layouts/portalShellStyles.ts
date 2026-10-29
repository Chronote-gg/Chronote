import {
  useComputedColorScheme,
  useMantineTheme,
  type AppShellStylesNames,
  type MantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { CSSProperties } from "react";
import {
  appBackground,
  portalBackground,
  shellBorder,
  shellFooterBackground,
  shellHeaderBackground,
  shellNavbarBackground,
  shellShadow,
} from "../uiTokens";
type StyleInput = {
  visualMode: boolean;
  visualNavbar: boolean;
  useInnerScroll: boolean;
  theme: MantineTheme;
  isDark: boolean;
};
function shellStyle({ visualMode, visualNavbar, theme, isDark }: StyleInput) {
  const navbarWidth = 300;
  const portalBackgroundImage = portalBackground(isDark);
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

  return appShellStyle;
}
function shellSectionStyles({
  visualMode,
  visualNavbar,
  useInnerScroll,
  theme,
  isDark,
}: StyleInput) {
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

  return appShellStyles;
}
export function usePortalShellStyles(
  visualMode: boolean,
  showNavbar: boolean,
  useInnerScroll: boolean,
) {
  const theme = useMantineTheme();
  const isDark = useComputedColorScheme("dark") === "dark";
  const desktopNavbar = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`);
  const input = {
    visualMode,
    visualNavbar: showNavbar && desktopNavbar,
    useInnerScroll,
    theme,
    isDark,
  };
  return { style: shellStyle(input), styles: shellSectionStyles(input) };
}
