import { useEffect, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { httpBatchLink } from "@trpc/client";
import {
  AuthenticatedPreviewProviders,
  createPreviewQueryClient,
} from "./AuthenticatedPreviewProviders";
import {
  unifiedBrowse,
  unifiedDetail,
  unifiedGuilds,
  unifiedUser,
  type UnifiedScenario,
} from "./unifiedMeetingsFixtures";
import { trpc } from "../services/trpc";
import PortalLayout from "../layouts/PortalLayout";
import UnifiedMeetingsPage from "../pages/UnifiedMeetingsPage";
import { meetingBrowseSearchSchema } from "../utils/meetingBrowseSearch";

export function UnifiedMeetingsPreview({
  path = "/portal/meetings",
  scenario = "mixed",
  colorScheme = "dark",
  manySources = false,
}: {
  path?: string;
  scenario?: UnifiedScenario;
  colorScheme?: "dark" | "light";
  manySources?: boolean;
}) {
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => setColorScheme(colorScheme), [colorScheme, setColorScheme]);
  const [queryClient] = useState(createPreviewQueryClient);
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async (rawUrl) => {
            const url = new URL(String(rawUrl), window.location.origin);
            const paths = decodeURIComponent(
              url.pathname.split("/trpc/")[1],
            ).split(",");
            if (paths.includes("meetings.myList") && scenario === "loading")
              await new Promise(() => {});
            if (paths.includes("meetings.myList") && scenario === "error")
              throw new Error("Access to this source is unavailable");
            const responses: Record<string, unknown> = {
              "auth.me": unifiedUser,
              "servers.listEligible": {
                guilds: manySources
                  ? [
                      ...unifiedGuilds,
                      ...Array.from({ length: 35 }, (_, index) => ({
                        id: `long-${index}`,
                        name: `Long collaboration source ${index + 1} with a missing icon`,
                        canManage: false,
                      })),
                    ]
                  : unifiedGuilds,
              },
              "meetings.myList": unifiedBrowse(url, scenario),
              "meetings.detail": unifiedDetail(url),
              "notion.automationStatus": { configured: false },
              "notion.status": { configured: false, connected: false },
              "notion.exportStatus": {
                exported: false,
                currentNotesVersion: 1,
                outdated: false,
              },
            };
            return new Response(
              JSON.stringify(
                paths.map((name) => ({
                  result: { data: responses[name] ?? null },
                })),
              ),
              { headers: { "Content-Type": "application/json" } },
            );
          },
        }),
      ],
    }),
  );
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const portal = createRoute({
      getParentRoute: () => root,
      path: "/portal",
      component: PortalLayout,
    });
    const meetings = createRoute({
      getParentRoute: () => portal,
      path: "meetings",
      component: UnifiedMeetingsPage,
      validateSearch: meetingBrowseSearchSchema.parse,
    });
    return createRouter({
      routeTree: root.addChildren([portal.addChildren([meetings])]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
  });
  return (
    <AuthenticatedPreviewProviders client={client} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AuthenticatedPreviewProviders>
  );
}
