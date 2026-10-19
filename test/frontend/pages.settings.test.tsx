import React from "react";
import { MantineProvider } from "@mantine/core";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { guildState } from "./testUtils";
import {
  autorecordAddMutation,
  autorecordRemoveMutation,
  channelContextsSetMutation,
  configServerQuery,
  setAutorecordListQuery,
  setChannelContextsQuery,
  setConfigServerQuery,
  setServersChannelsQuery,
} from "./mocks/trpc";
import Settings from "../../src/frontend/pages/Settings";
import { CONFIG_KEYS } from "../../src/config/keys";

describe("Settings page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    guildState.selectedGuildId = "g1";
    guildState.loading = false;
    setServersChannelsQuery({
      data: {
        voiceChannels: [],
        textChannels: [],
      },
    });
    setAutorecordListQuery({
      data: {
        rules: [
          {
            guildId: "g1",
            channelId: "ALL",
            enabled: true,
            recordAll: true,
            createdBy: "u1",
            createdAt: "2025-12-01T00:00:00.000Z",
          },
        ],
      },
    });
    setConfigServerQuery({
      data: {
        registry: [
          {
            key: CONFIG_KEYS.autorecord.enabled,
            label: "Auto-record",
            description: "Automatically record meetings by default.",
            category: "Auto-record",
            valueType: "boolean",
            defaultValue: false,
            scopes: {
              server: {
                enabled: true,
                required: true,
                role: "admin",
                control: "toggle",
              },
            },
            ui: { type: "toggle" },
          },
          {
            key: CONFIG_KEYS.notes.channelId,
            label: "Notes channel",
            description:
              "Default notes channel for meetings and auto-recording.",
            category: "Notes",
            valueType: "string",
            scopes: {
              server: {
                enabled: true,
                required: false,
                role: "admin",
                control: "text",
              },
            },
            ui: { type: "custom", renderer: "NotesChannelSelect" },
          },
          {
            key: CONFIG_KEYS.ask.sharingPolicy,
            label: "Ask sharing policy",
            description: "Default sharing policy for Ask conversations.",
            category: "Ask",
            valueType: "select",
            defaultValue: "server",
            scopes: {
              server: {
                enabled: true,
                required: false,
                role: "admin",
                control: "select",
              },
            },
            ui: { type: "segmented", options: ["off", "server", "public"] },
          },
        ],
        snapshot: {
          values: {
            [CONFIG_KEYS.autorecord.enabled]: {
              value: true,
              source: "server",
            },
            [CONFIG_KEYS.notes.channelId]: { value: "", source: "server" },
            [CONFIG_KEYS.ask.sharingPolicy]: {
              value: "server",
              source: "server",
            },
          },
          experimentalEnabled: false,
          tier: "free",
          missingRequired: [],
        },
        overrides: [],
      },
    });
    setChannelContextsQuery({ data: { contexts: [] } });
  });

  test("shows record-all warning when default notes channel is missing", async () => {
    renderWithMantine(<Settings />);

    await waitFor(() => {
      expect(
        screen.getByText(/Record-all requires a default notes channel/i),
      ).toBeInTheDocument();
    });
    const saveButtons = screen.getAllByRole("button", {
      name: /save settings/i,
    });
    saveButtons.forEach((button) => {
      expect(button).toBeDisabled();
    });
  });

  test("shows public sharing policy option and helper copy", async () => {
    renderWithMantine(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Ask sharing policy/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Public")).toBeInTheDocument();
  });
});

describe("independent notes routing", () => {
  beforeAll(() =>
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: jest.fn(),
    }),
  );
  afterAll(() =>
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"),
  );
  const savedContext = {
    guildId: "g1",
    channelId: "voice",
    context: "Keep context",
    defaultNotesChannelId: "other",
    liveVoiceEnabled: true,
    liveVoiceCommandsEnabled: false,
    chatTtsEnabled: false,
    chatTtsTtsOnlyEnabled: true,
    updatedAt: "now",
    updatedBy: "admin",
  };
  beforeEach(() => {
    resetFrontendMocks();
    guildState.selectedGuildId = "g1";
    guildState.loading = false;
    setServersChannelsQuery({
      data: {
        voiceChannels: [{ id: "voice", name: "Voice Lounge", botAccess: true }],
        textChannels: [
          { id: "notes", name: "notes", botAccess: true },
          { id: "other", name: "staff-notes", botAccess: true },
        ],
      },
    });
    setAutorecordListQuery({ data: { rules: [] } });
    setChannelContextsQuery({ data: { contexts: [] } });
    setDefault("notes");
  });
  function setDefault(value: string) {
    const data = configServerQuery.data;
    if (!data) throw new Error("Missing config fixture");
    setConfigServerQuery({
      data: {
        ...data,
        snapshot: {
          ...data.snapshot,
          values: {
            ...data.snapshot.values,
            [CONFIG_KEYS.notes.channelId]: { value, source: "server" },
          },
        },
      },
    });
  }
  async function openRow(channelName = "Voice Lounge") {
    fireEvent.click(
      await screen.findByRole("button", { name: `Edit ${channelName}` }),
    );
    return screen.findByRole("dialog");
  }
  const notesField = (dialog: HTMLElement) =>
    within(dialog).getByRole("combobox", { name: "Notes channel" });
  const saveButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Save channel" });
  const autoRecordSwitch = (dialog: HTMLElement) =>
    within(dialog).getByRole("switch", { name: "Auto-record this channel" });
  const resetNotes = (dialog: HTMLElement) =>
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset to server default" }),
    );
  async function selectNotes(dialog: HTMLElement, label: string) {
    fireEvent.click(notesField(dialog));
    fireEvent.click(
      await screen.findByRole("option", { name: label, hidden: true }),
    );
  }
  test("routing_without_auto_record", async () => {
    renderWithMantine(<Settings />);
    const dialog = await openRow();
    expect(notesField(dialog)).toBeEnabled();
    expect(autoRecordSwitch(dialog)).not.toBeChecked();
    await selectNotes(dialog, "#staff-notes");
    fireEvent.click(saveButton(dialog));
    await waitFor(() =>
      expect(channelContextsSetMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ defaultNotesChannelId: "other" }),
      ),
    );
    expect(autorecordAddMutation.mutateAsync).not.toHaveBeenCalled();
    expect(autorecordRemoveMutation.mutateAsync).not.toHaveBeenCalled();
  });
  test.each([
    [false, "Voice Lounge"],
    [true, "Voice Lounge"],
    [false, "Context only"],
    [true, "Context only"],
    [false, "Notes only"],
    [true, "Notes only"],
  ])(
    "overview shows effective recording and routing-only saves preserve rules (record-all=%s, channel=%s)",
    async (recordAll, editedChannel) => {
      const serverRule = {
        guildId: "g1",
        channelId: "ALL",
        enabled: true,
        recordAll: true,
        createdAt: "now",
        createdBy: "admin",
      };
      const channelRule = {
        ...serverRule,
        channelId: "explicit",
        recordAll: false,
      };
      setAutorecordListQuery({
        data: { rules: recordAll ? [serverRule, channelRule] : [channelRule] },
      });
      setServersChannelsQuery({
        data: {
          voiceChannels: [
            { id: "voice", name: "Voice Lounge", botAccess: true },
            { id: "context", name: "Context only", botAccess: true },
            { id: "notes-only", name: "Notes only", botAccess: true },
            { id: "explicit", name: "Explicit rule", botAccess: true },
          ],
          textChannels: [
            { id: "notes", name: "notes", botAccess: true },
            { id: "other", name: "staff-notes", botAccess: true },
          ],
        },
      });
      setChannelContextsQuery({
        data: {
          contexts: [
            {
              ...savedContext,
              channelId: "context",
              defaultNotesChannelId: undefined,
            },
            { ...savedContext, channelId: "notes-only", context: "" },
          ],
        },
      });
      renderWithMantine(<Settings />);
      const rows = screen.getAllByTestId("settings-override");
      for (const name of ["Voice Lounge", "Context only", "Notes only"]) {
        const row = rows.find((entry) => within(entry).queryByText(name));
        expect(row).toHaveTextContent(
          recordAll
            ? "Auto-record on \u00b7 Server default"
            : "Auto-record off \u00b7 Server default",
        );
      }
      const explicit = rows.find((entry) =>
        within(entry).queryByText("Explicit rule"),
      );
      expect(explicit).toHaveTextContent(
        "Auto-record on \u00b7 Voice channel override",
      );
      const inheritedRow = rows.find((entry) =>
        within(entry).queryByText("Voice Lounge"),
      );
      if (!inheritedRow) throw new Error("Missing inherited voice row");
      expect(
        within(inheritedRow).queryByRole("button", { name: "Remove override" }),
      ).not.toBeInTheDocument();
      const dialog = await openRow(editedChannel);
      expect(autoRecordSwitch(dialog)).not.toBeChecked();
      await selectNotes(dialog, "#notes");
      fireEvent.click(saveButton(dialog));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(channelContextsSetMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ defaultNotesChannelId: "notes" }),
      );
      expect(autorecordAddMutation.mutateAsync).not.toHaveBeenCalled();
      expect(autorecordRemoveMutation.mutateAsync).not.toHaveBeenCalled();
    },
  );
  test("reset_only_clears_notes_override", async () => {
    setChannelContextsQuery({ data: { contexts: [savedContext] } });
    setAutorecordListQuery({
      data: {
        rules: [
          {
            guildId: "g1",
            channelId: "voice",
            enabled: true,
            recordAll: false,
            textChannelId: "other",
            tags: ["recap"],
            createdAt: "now",
            createdBy: "admin",
          },
        ],
      },
    });
    const view = renderWithMantine(<Settings />);
    const dialog = await openRow();
    resetNotes(dialog);
    fireEvent.click(saveButton(dialog));
    await waitFor(() =>
      expect(channelContextsSetMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultNotesChannelId: null,
          context: "Keep context",
          liveVoiceEnabled: true,
          liveVoiceCommandsEnabled: false,
          chatTtsEnabled: false,
          chatTtsTtsOnlyEnabled: true,
        }),
      ),
    );
    expect(autorecordAddMutation.mutateAsync).toHaveBeenCalledWith({
      serverId: "g1",
      mode: "one",
      voiceChannelId: "voice",
      tags: ["recap"],
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const inheritedContext = {
      ...savedContext,
      defaultNotesChannelId: undefined,
    };
    setChannelContextsQuery({ data: { contexts: [inheritedContext] } });
    setAutorecordListQuery({
      data: {
        rules: [
          {
            guildId: "g1",
            channelId: "voice",
            enabled: true,
            recordAll: false,
            tags: ["recap"],
            createdAt: "now",
            createdBy: "admin",
          },
        ],
      },
    });
    view.rerender(
      <MantineProvider>
        <Settings />
      </MantineProvider>,
    );
    const reopened = await openRow();
    expect(notesField(reopened)).toHaveValue("Use server default (#notes)");
    expect(
      within(reopened).getByRole("textbox", { name: "Channel context" }),
    ).toHaveValue("Keep context");
    expect(within(reopened).getByRole("textbox", { name: "Tags" })).toHaveValue(
      "recap",
    );
  });
  test("equal_default_is_still_explicit", async () => {
    setChannelContextsQuery({
      data: { contexts: [{ ...savedContext, defaultNotesChannelId: "notes" }] },
    });
    const view = renderWithMantine(<Settings />);
    expect(screen.getByTestId("settings-override")).toHaveTextContent(
      "Voice channel override",
    );
    setDefault("other");
    view.rerender(
      <MantineProvider>
        <Settings />
      </MantineProvider>,
    );
    expect(screen.getByTestId("settings-override")).toHaveTextContent("#notes");
    const dialog = await openRow();
    expect(notesField(dialog)).toHaveValue("#notes");
  });
  test("toggle_save_preserves_route", async () => {
    setChannelContextsQuery({ data: { contexts: [savedContext] } });
    renderWithMantine(<Settings />);
    const dialog = await openRow();
    fireEvent.click(autoRecordSwitch(dialog));
    fireEvent.click(saveButton(dialog));
    await waitFor(() =>
      expect(channelContextsSetMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ defaultNotesChannelId: "other" }),
      ),
    );
    expect(autorecordAddMutation.mutateAsync).toHaveBeenCalledWith({
      serverId: "g1",
      mode: "one",
      voiceChannelId: "voice",
      tags: undefined,
    });
  });
  test("inherited_rows_remain_editable", async () => {
    const view = renderWithMantine(<Settings />);
    const row = screen.getByTestId("settings-override");
    expect(row).toHaveTextContent("#notes");
    expect(row).toHaveTextContent("Server default");
    expect(
      within(row).queryByRole("button", { name: "Remove override" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add override" })).toBeEnabled();
    setDefault("other");
    view.rerender(
      <MantineProvider>
        <Settings />
      </MantineProvider>,
    );
    expect(screen.getByTestId("settings-override")).toHaveTextContent(
      "#staff-notes",
    );
    const dialog = await openRow();
    expect(notesField(dialog)).toBeEnabled();
  });
  test("requires a destination for recording while inherited routing stays editable without a default", async () => {
    setDefault("");
    renderWithMantine(<Settings />);
    const dialog = await openRow();
    expect(notesField(dialog)).toHaveValue("Use server default");
    expect(saveButton(dialog)).toBeEnabled();
    fireEvent.click(autoRecordSwitch(dialog));
    expect(saveButton(dialog)).toBeDisabled();
    await selectNotes(dialog, "#staff-notes");
    expect(saveButton(dialog)).toBeEnabled();
  });
  test("retains TTS-only destination validation", async () => {
    setDefault("");
    setChannelContextsQuery({
      data: {
        contexts: [
          {
            ...savedContext,
            defaultNotesChannelId: undefined,
            chatTtsEnabled: true,
            chatTtsTtsOnlyEnabled: true,
          },
        ],
      },
    });
    renderWithMantine(<Settings />);
    const dialog = await openRow();
    expect(notesField(dialog)).toBeEnabled();
    expect(saveButton(dialog)).toBeDisabled();
    await selectNotes(dialog, "#staff-notes");
    expect(saveButton(dialog)).toBeEnabled();
  });
  test("keeps an unavailable saved destination explicit until corrected", async () => {
    setChannelContextsQuery({
      data: {
        contexts: [{ ...savedContext, defaultNotesChannelId: "deleted" }],
      },
    });
    renderWithMantine(<Settings />);
    expect(screen.getByTestId("settings-override")).toHaveTextContent(
      "Unavailable notes channel",
    );
    expect(screen.getByTestId("settings-override")).toHaveTextContent(
      "Voice channel override",
    );
    const dialog = await openRow();
    expect(notesField(dialog)).toHaveValue("Unavailable notes channel");
    expect(saveButton(dialog)).toBeDisabled();
    resetNotes(dialog);
    expect(notesField(dialog)).toHaveValue("Use server default (#notes)");
    expect(saveButton(dialog)).toBeEnabled();
  });
  test("failed_save_retains_draft", async () => {
    channelContextsSetMutation.mutateAsync.mockRejectedValueOnce(
      new Error("Save unavailable"),
    );
    renderWithMantine(<Settings />);
    const dialog = await openRow();
    await selectNotes(dialog, "#staff-notes");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Channel context" }),
      { target: { value: "Unsaved context" } },
    );
    fireEvent.click(saveButton(dialog));
    expect(
      await within(dialog).findByText(
        "Could not save channel settings. Try again.",
      ),
    ).toBeInTheDocument();
    expect(notesField(dialog)).toHaveValue("#staff-notes");
    expect(
      within(dialog).getByRole("textbox", { name: "Channel context" }),
    ).toHaveValue("Unsaved context");
  });
});
