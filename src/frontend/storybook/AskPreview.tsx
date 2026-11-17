import { useEffect, useState } from "react";
import { httpBatchLink } from "@trpc/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import Ask from "../pages/Ask";
import PortalLayout from "../layouts/PortalLayout";
import { useGuildContext } from "../contexts/GuildContext";
import { trpc } from "../services/trpc";
import {
  AuthenticatedPreviewProviders,
  createPreviewQueryClient,
} from "./AuthenticatedPreviewProviders";

function PreviewServerSelection() {
  const { guilds, selectedGuildId, setSelectedGuildId } = useGuildContext();
  useEffect(() => {
    if (guilds.length && selectedGuildId !== "example")
      setSelectedGuildId("example");
  }, [guilds, selectedGuildId, setSelectedGuildId]);
  return <Outlet />;
}

export function AskPreview({
  scenario = "ready",
  submissionFails = false,
  agentEnabled = true,
  searchEnabled = true,
}: {
  scenario?: "ready" | "empty" | "loading" | "error" | "no-notes";
  submissionFails?: boolean;
  agentEnabled?: boolean;
  searchEnabled?: boolean;
}) {
  const [queryClient] = useState(createPreviewQueryClient);
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async (url) => {
            const paths = new URL(String(url), window.location.origin).pathname
              .split("/")
              .at(-1)!
              .split(",");
            if (paths.includes("ask.startingContext")) {
              if (scenario === "loading") await new Promise(() => {});
              if (scenario === "error")
                throw new Error("Preview: meeting list unavailable");
            }
            if (submissionFails && paths.includes("ask.startRun"))
              throw new Error("Preview: question could not be sent");
            const conversation = {
              id: "preview-chat",
              title: "Preview question",
              summary: "Preview answer",
              createdAt: "2026-11-17T00:00:00Z",
              updatedAt: "2026-11-17T00:00:00Z",
              visibility: "private",
            };
            const messages = [
              {
                id: "preview-user",
                role: "user",
                text: "Preview question",
                createdAt: conversation.createdAt,
              },
              {
                id: "preview-answer",
                role: "chronote",
                text: "Preview answer",
                createdAt: conversation.createdAt,
              },
            ];
            const data: Record<string, unknown> = {
              "auth.me": {
                id: "story-user",
                username: "Preview",
                avatar: null,
              },
              "servers.listEligible": {
                guilds: [
                  { id: "example", name: "Engineering HQ", canManage: true },
                ],
              },
              "ask.settings": {
                agentEnabled,
                searchEnabled,
                askMembersEnabled: true,
                askSharingPolicy: "server",
              },
              "ask.listConversations": { conversations: [] },
              "ask.ask": {
                conversationId: conversation.id,
                answer: "Preview answer",
                conversation,
                messages,
              },
              "ask.startRun": {
                runId: "preview-run",
                requestId: "preview-request",
                status: "completed",
                text: "Preview answer",
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
                result: {
                  conversationId: conversation.id,
                  answer: "Preview answer",
                  conversation,
                  messages,
                },
                conversationId: conversation.id,
                answer: "Preview answer",
                conversation,
                messages,
              },
              "ask.searchMeetings": {
                hits: [
                  {
                    meeting: { serverId: "example", id: "old-planning" },
                    title: "Earlier planning",
                    startedAt: "2025-01-01T14:00:00Z",
                  },
                ],
                nextCursor: null,
                coverage: { status: "partial" },
              },
              "ask.getConversation": { conversation, messages },
              "ask.startingContext": {
                coverage: {
                  status: "ready",
                  semanticStatus: "ready",
                  ranking: "authorized_partition_order",
                },
                count: scenario === "empty" ? 0 : 8,
                notesCount:
                  scenario === "empty" || scenario === "no-notes" ? 0 : 6,
                meetings:
                  scenario === "empty" || scenario === "no-notes"
                    ? []
                    : [
                        {
                          id: "planning",
                          title: "Product planning",
                          timestamp: "2026-11-16T14:00:00Z",
                        },
                        {
                          id: "team",
                          title: "Weekly team catch-up",
                          timestamp: "2026-11-15T14:00:00Z",
                        },
                        {
                          id: "launch",
                          title: "Launch review",
                          timestamp: "2026-11-14T14:00:00Z",
                        },
                      ],
              },
            };
            if (paths.some((path) => !(path in data)))
              throw new Error("Preview only: unsupported request");
            return new Response(
              JSON.stringify(
                paths.map((path) => ({ result: { data: data[path] } })),
              ),
              { headers: { "Content-Type": "application/json" } },
            );
          },
        }),
      ],
    }),
  );
  const [router] = useState(() => {
    localStorage.setItem("mn-selected-guild", "example");
    const root = createRootRoute({ component: Outlet });
    const portal = createRoute({
      getParentRoute: () => root,
      path: "portal",
      component: PortalLayout,
    });
    const server = createRoute({
      getParentRoute: () => portal,
      path: "server/$serverId",
      component: PreviewServerSelection,
    });
    const ask = createRoute({
      getParentRoute: () => server,
      path: "ask",
      component: Ask,
      validateSearch: (search) => search,
    });
    return createRouter({
      routeTree: root.addChildren([
        portal.addChildren([server.addChildren([ask])]),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/portal/server/example/ask"],
      }),
    });
  });
  return (
    <AuthenticatedPreviewProviders client={client} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AuthenticatedPreviewProviders>
  );
}
