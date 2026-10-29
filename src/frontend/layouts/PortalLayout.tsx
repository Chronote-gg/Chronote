import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
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
    loginUrl,
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
      {authState === "unauthenticated" ? (
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
      ) : ready ? (
        <Outlet />
      ) : (
        <Center py="xl">
          <Stack gap="xs" align="center">
            <Loader color="brand" />
            <Text c="dimmed">Loading your portal...</Text>
          </Stack>
        </Center>
      )}
    </PortalShell>
  );
  return ready ? (
    <MeetingBrowseProvider
      search={browseSearch}
      enabled={pathname === "/portal/meetings"}
    >
      {shell}
    </MeetingBrowseProvider>
  ) : (
    shell
  );
}
