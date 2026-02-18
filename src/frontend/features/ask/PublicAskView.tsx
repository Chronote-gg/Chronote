import { useEffect, type CSSProperties } from "react";
import {
  AppShell,
  Box,
  Container,
  LoadingOverlay,
  Stack,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import type { MantineTheme } from "@mantine/core";
import AuthBanner from "../../components/AuthBanner";
import PageHeader from "../../components/PageHeader";
import SiteFooter from "../../components/SiteFooter";
import SiteHeader from "../../components/SiteHeader";
import Surface from "../../components/Surface";
import { useVisualMode } from "../../hooks/useVisualMode";
import { useSharePageMeta } from "../../hooks/useSharePageMeta";
import type {
  AskConversation,
  AskMessage,
  AskSharedConversation,
} from "../../../types/ask";
import {
  appBackground,
  pagePaddingX,
  portalBackground,
  shellBorder,
  shellHeaderBackground,
  shellHeights,
  shellShadow,
  uiOverlays,
} from "../../uiTokens";
import { PublicAskBody } from "./PublicAskBody";

const buildHeaderStyles = (
  theme: MantineTheme,
  isDark: boolean,
  visualMode: boolean,
): CSSProperties =>
  visualMode
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
      };

const buildMainStyles = (
  theme: MantineTheme,
  isDark: boolean,
  visualMode: boolean,
): CSSProperties =>
  visualMode
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
      };

type PublicAskViewProps = {
  conversation: AskConversation | null;
  messages: AskMessage[];
  sharedMeta: AskSharedConversation | null;
  isLoading: boolean;
  hasError: boolean;
  highlightedMessageId: string | null;
};

export function PublicAskView({
  conversation,
  messages,
  sharedMeta,
  isLoading,
  hasError,
  highlightedMessageId,
}: PublicAskViewProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("dark");
  const isDark = colorScheme === "dark";
  const visualMode = useVisualMode();

  useSharePageMeta();

  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = document.querySelector(
      `[data-message-id="${highlightedMessageId}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedMessageId, messages.length]);

  const headerStyles = buildHeaderStyles(theme, isDark, visualMode);
  const mainStyles = buildMainStyles(theme, isDark, visualMode);
  const pageTitle = conversation?.title ?? "Shared Ask";

  return (
    <AppShell
      padding={0}
      header={{ height: shellHeights.header }}
      style={{
        minHeight: visualMode ? "100vh" : undefined,
        height: visualMode ? "auto" : undefined,
        overflow: visualMode ? "visible" : undefined,
      }}
      styles={{
        header: headerStyles,
        main: mainStyles,
      }}
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
          py={{ base: "xl", md: "xl" }}
          style={{ backgroundImage: portalBackground(isDark) }}
        >
          <Container size="md" px={pagePaddingX}>
            <Stack gap="lg">
              <PageHeader
                title={pageTitle}
                description="Read-only thread shared from Chronote."
              />
              <AuthBanner message="Connect to ask Chronote about your own meetings." />
              <Surface
                p="lg"
                style={{ position: "relative", overflow: "hidden" }}
              >
                <LoadingOverlay
                  visible={isLoading}
                  overlayProps={uiOverlays.loading}
                  loaderProps={{ size: "md" }}
                />
                <PublicAskBody
                  isLoading={isLoading}
                  hasError={hasError}
                  conversation={conversation}
                  messages={messages}
                  sharedMeta={sharedMeta}
                  highlightedMessageId={highlightedMessageId}
                />
              </Surface>
            </Stack>
          </Container>
          <SiteFooter />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export type { PublicAskViewProps };
