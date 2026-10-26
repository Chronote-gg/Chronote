import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { useMantineColorScheme } from "@mantine/core";
import { QueryClient } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AuthenticatedPreviewProviders } from "../../storybook/AuthenticatedPreviewProviders";
import { trpc } from "../../services/trpc";
import Settings from "../../pages/Settings";
import type { ConfigEntryInput } from "../../types/configEntry";

const notesEntry: ConfigEntryInput = {
  key: "notes.channelId",
  label: "Default notes channel",
  description: "Default destination for recording controls and notes.",
  category: "Notes",
  group: "Recommended",
  valueType: "string",
  scopes: {
    server: { enabled: true, required: false, role: "admin", control: "text" },
  },
  ui: { type: "custom", renderer: "NotesChannelSelect" },
};
type PreviewProps = {
  colorScheme?: "light" | "dark";
  destination?:
    "inherited" | "explicit" | "equal" | "unconfigured" | "unavailable";
  saveState?: "ready" | "saving" | "error";
  recordAll?: boolean;
};
function previewResponses(
  destination: NonNullable<PreviewProps["destination"]>,
  recordAll: boolean,
): Record<string, unknown> {
  const defaultId = destination === "unconfigured" ? "" : "notes";
  const overrideId =
    destination === "unavailable"
      ? "deleted"
      : destination === "explicit"
        ? "staff"
        : destination === "equal"
          ? "notes"
          : undefined;
  return {
    "auth.me": { id: "fictional-user", username: "Preview", avatar: null },
    "servers.listEligible": {
      guilds: [
        { id: "fictional-server", name: "Example team", canManage: true },
      ],
    },
    "servers.channels": {
      voiceChannels: [
        {
          id: "voice",
          name: "Weekly planning and cross-team project updates",
          botAccess: true,
          missingPermissions: [],
        },
      ],
      textChannels: [
        {
          id: "notes",
          name: "meeting-notes",
          botAccess: true,
          missingPermissions: [],
        },
        {
          id: "staff",
          name: "staff-project-planning-and-follow-up-notes",
          botAccess: true,
          missingPermissions: [],
        },
      ],
    },
    "config.server": {
      registry: [notesEntry],
      overrides: [],
      snapshot: {
        values: {
          "notes.channelId": {
            key: "notes.channelId",
            value: defaultId,
            source: "server",
          },
        },
        experimentalEnabled: false,
        tier: "pro",
        missingRequired: [],
      },
    },
    "autorecord.list": {
      rules: recordAll
        ? [{ channelId: "ALL", enabled: true, recordAll: true }]
        : [],
    },
    "channelContexts.list": {
      contexts: overrideId
        ? [{ channelId: "voice", defaultNotesChannelId: overrideId }]
        : [],
    },
    "dictionary.list": { entries: [] },
    "notion.automationStatus": { configured: false, userConnected: false },
    "serviceAccounts.list": { serviceAccounts: [], canCreate: false },
    "channelContexts.set": { ok: true },
  };
}
function NotesDestinationPreview({
  colorScheme = "dark",
  destination = "inherited",
  saveState = "ready",
  recordAll = false,
}: PreviewProps) {
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => setColorScheme(colorScheme), [colorScheme, setColorScheme]);
  const [queryClient] = useState(() => {
    const noRetry = { retry: false };
    return new QueryClient({
      defaultOptions: { queries: noRetry, mutations: noRetry },
    });
  });
  const [client] = useState(() => {
    let failed = false;
    const data = previewResponses(destination, recordAll);
    async function fetchPreview(url: RequestInfo | URL) {
      const paths =
        new URL(String(url), window.location.origin).pathname
          .split("/")
          .at(-1)
          ?.split(",") ?? [];
      if (paths.includes("channelContexts.set")) {
        if (saveState === "saving") await new Promise(() => {});
        if (saveState === "error" && !failed) {
          failed = true;
          throw new Error("Fictional save failure");
        }
      }
      if (paths.some((name) => !(name in data)))
        throw new Error("Unsupported fictional settings action");
      return new Response(
        JSON.stringify(paths.map((name) => ({ result: { data: data[name] } }))),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return trpc.createClient({
      links: [httpBatchLink({ url: "/trpc", fetch: fetchPreview })],
    });
  });
  const [router] = useState(() => {
    localStorage.setItem("mn-selected-guild", "fictional-server");
    return createRouter({
      routeTree: createRootRoute({ component: Settings }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });
  return (
    <AuthenticatedPreviewProviders client={client} queryClient={queryClient}>
      <div style={{ padding: 16, background: "var(--mantine-color-body)" }}>
        {/* Keep this component story focused on notes routing. */}
        <style>{`[data-testid="settings-dictionary"], [data-testid="settings-notion-integration"], [data-testid="service-accounts-card"] { display: none; }`}</style>
        <RouterProvider router={router} />
      </div>
    </AuthenticatedPreviewProviders>
  );
}
const meta = {
  title: "Settings/NotesDestination",
  tags: ["notes-destination"],
  component: NotesDestinationPreview,
} satisfies Meta<typeof NotesDestinationPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inherited: Story = {};
export const InheritedRecordAll: Story = {
  args: { recordAll: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Auto-record on \u00b7 Server default",
      ),
    ).toBeVisible();
  },
};
export const InheritedRecordAllMobile: Story = {
  ...InheritedRecordAll,
  play: async ({ canvasElement }) => {
    const recordingState = await within(canvasElement).findByText(
      "Auto-record on \u00b7 Server default",
    );
    recordingState.scrollIntoView({ block: "center" });
    await expect(recordingState).toBeVisible();
  },
};
export const Explicit: Story = { args: { destination: "explicit" } };
export const EqualToDefault: Story = { args: { destination: "equal" } };
export const Unconfigured: Story = { args: { destination: "unconfigured" } };
const openEditor: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await userEvent.click(
    await within(canvasElement).findByRole("button", {
      name: "Edit Weekly planning and cross-team project updates",
    }),
  );
  await expect(
    await within(document.body).findByRole("switch", {
      name: "Auto-record this channel",
    }),
  ).not.toBeChecked();
  await expect(
    within(document.body).getByRole("combobox", {
      name: "Notes channel",
    }),
  ).toBeEnabled();
};
export const Editor: Story = { play: openEditor };
export const EditorLight: Story = {
  args: { colorScheme: "light" },
  play: openEditor,
};
export const EditorTablet: Story = { play: openEditor };
export const EditorLightTablet: Story = {
  args: { colorScheme: "light" },
  play: openEditor,
};
export const EditorMobile: Story = { play: openEditor };
export const EditorLightMobile: Story = {
  args: { colorScheme: "light" },
  play: openEditor,
};
export const Unavailable: Story = {
  args: { destination: "unavailable" },
  play: async (context) => {
    await openEditor(context);
    await waitFor(() =>
      expect(
        within(document.body).getByText(
          "Unavailable notes channel. Choose an available channel or reset to the server default.",
        ),
      ).toBeVisible(),
    );
  },
};
export const Saving: Story = {
  args: { saveState: "saving" },
  play: async (context) => {
    await openEditor(context);
    const save = within(document.body).getByRole("button", {
      name: "Save channel",
    });
    await userEvent.click(save);
    await expect(save).toHaveAttribute("data-loading", "true");
  },
};
export const ErrorRecovery: Story = {
  args: { saveState: "error" },
  play: async (context) => {
    await openEditor(context);
    const body = within(document.body);
    await userEvent.click(body.getByRole("button", { name: "Save channel" }));
    await waitFor(() =>
      expect(
        body.getByText("Could not save channel settings. Try again."),
      ).toBeVisible(),
    );
    await userEvent.click(body.getByRole("button", { name: "Save channel" }));
    await waitFor(() =>
      expect(body.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  },
};
export const SaveError: Story = {
  args: { saveState: "error" },
  play: async (context) => {
    await openEditor(context);
    await userEvent.click(
      within(document.body).getByRole("button", { name: "Save channel" }),
    );
    await waitFor(() =>
      expect(
        within(document.body).getByText(
          "Could not save channel settings. Try again.",
        ),
      ).toBeVisible(),
    );
  },
};
