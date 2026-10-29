import { AppShell, Container } from "@mantine/core";
import SiteFooter from "../components/SiteFooter";
import SiteHeader from "../components/SiteHeader";
import SiteNavbar from "../components/SiteNavbar";
import {
  pagePaddingX,
  pagePaddingY,
  pagePaddingYCompact,
  shellHeights,
} from "../uiTokens";

import type { ComponentProps, ReactNode } from "react";
import { usePortalShellStyles } from "./portalShellStyles";
type PortalShellProps = {
  children: ReactNode;
  pathname: string;
  visualMode: boolean;
  useInnerScroll: boolean;
  showNavbar: boolean;
  layoutNavbar: boolean;
  navbarOpened: boolean;
  onNavbarToggle: () => void;
  onNavbarClose: () => void;
  headerContext: ComponentProps<typeof SiteHeader>["context"];
};
export default function PortalShell({
  children,
  pathname,
  visualMode,
  useInnerScroll,
  showNavbar,
  layoutNavbar,
  navbarOpened,
  onNavbarToggle,
  onNavbarClose,
  headerContext,
}: PortalShellProps) {
  const { style, styles } = usePortalShellStyles(
    visualMode,
    layoutNavbar,
    useInnerScroll,
  );
  return (
    <AppShell
      padding={0}
      header={{ height: shellHeights.header }}
      footer={{ height: shellHeights.footer }}
      style={style}
      navbar={
        showNavbar
          ? {
              width: 300,
              breakpoint: "sm",
              collapsed: { mobile: !navbarOpened },
            }
          : undefined
      }
      styles={styles}
    >
      <AppShell.Header p="md">
        <SiteHeader
          showNavbarToggle={showNavbar}
          navbarOpened={navbarOpened}
          onNavbarToggle={onNavbarToggle}
          context={headerContext}
        />
      </AppShell.Header>
      {showNavbar ? (
        <AppShell.Navbar p={0}>
          <SiteNavbar onClose={onNavbarClose} pathname={pathname} />
        </AppShell.Navbar>
      ) : null}
      <AppShell.Main
        data-testid={
          pathname === "/portal/meetings" ? "meeting-browse-scroll" : undefined
        }
      >
        <Container
          size="xl"
          px={pagePaddingX}
          pt={pagePaddingY}
          pb={{
            base: useInnerScroll ? pagePaddingYCompact.base : pagePaddingY.base,
            md: useInnerScroll ? pagePaddingYCompact.md : pagePaddingY.md,
          }}
          style={{
            display: useInnerScroll ? "flex" : "block",
            flexDirection: useInnerScroll ? "column" : undefined,
            minHeight: 0,
            height: useInnerScroll ? "100%" : undefined,
          }}
        >
          {children}
        </Container>
      </AppShell.Main>
      <AppShell.Footer>
        <SiteFooter variant="compact" />
      </AppShell.Footer>
    </AppShell>
  );
}
