import { useDisclosure } from "@mantine/hooks";
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import { ProtectedSessionBoundary } from "../components/ProtectedSessionBoundary";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";
import { MeetingBrowseProvider } from "../contexts/MeetingBrowseContext";
import { useVisualMode } from "../hooks/useVisualMode";
import { meetingBrowseSearchSchema } from "../utils/meetingBrowseSearch";
import PortalShell from "./PortalShell";

export default function PortalLayout() {
  const rawSearch = useSearch({ strict: false });

  const [navbarOpened, navbarHandlers] = useDisclosure(false);
  const {
    state: authState,
    loading: authLoading,
    protectedQueriesReady,
  } = useAuth();
  const { loading: guildLoading } = useGuildContext();
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
  const isServerWorkspace = pathname.startsWith("/portal/server/");
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

  const ready =
    authState === "authenticated" &&
    !authLoading &&
    protectedQueriesReady &&
    !guildLoading;
  const shell = (
    <PortalShell
      pathname={pathname}
      visualMode={visualMode}
      useInnerScroll={authState === "unauthenticated" ? false : useInnerScroll}
      layoutNavbar={showNavbar}
      showNavbar={ready && showNavbar}
      navbarOpened={ready && navbarOpened}
      onNavbarToggle={ready ? navbarHandlers.toggle : () => {}}
      onNavbarClose={navbarHandlers.close}
      headerContext={headerContext}
    >
      <ProtectedSessionBoundary loading={guildLoading}>
        <Outlet />
      </ProtectedSessionBoundary>
    </PortalShell>
  );
  return (
    <MeetingBrowseProvider
      search={browseSearch}
      enabled={ready && pathname === "/portal/meetings"}
    >
      {shell}
    </MeetingBrowseProvider>
  );
}
