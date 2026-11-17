/** @jest-environment node */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RepliableInteraction } from "discord.js";
import {
  resolveInteractionScope,
  type InteractionScope,
} from "../src/botInteractionScope";

jest.mock("../src/commands/dismissAutoRecord", () => ({
  DISMISS_AUTORECORD_COMMAND_NAME: "Stop recording",
}));

const COMMANDS_DIR = path.join(__dirname, "../src/commands");
const BOT_USER = "synthetic-bot";

type Probe =
  | { button: string }
  | { modal: string }
  | { command: string }
  | { context: string };

/**
 * Every command module whose handler reads the live session, and the
 * interactions that reach it. A module that starts reading the live session
 * fails this test until it is classified here and in the routing lists.
 */
const LIVE_SESSION_READERS: Record<
  string,
  { scope: InteractionScope; probes: Probe[] }
> = {
  "dismissAutoRecord.ts": {
    scope: "owner",
    probes: [{ context: "Stop recording" }],
  },
  "endMeeting.ts": { scope: "owner", probes: [{ button: "end_meeting" }] },
  "leave.ts": { scope: "owner", probes: [{ command: "leave" }] },
  "generateImage.ts": {
    scope: "session",
    probes: [{ button: "generate_image" }],
  },
  "say.ts": { scope: "session", probes: [{ command: "say" }] },
  "tags.ts": {
    scope: "session",
    probes: [{ button: "edit_tags" }, { modal: "edit_tags_modal" }],
  },
  "tts.ts": { scope: "session", probes: [{ command: "tts" }] },
  // Reads the live map only to refuse a second start; a start is general.
  "startMeeting.ts": {
    scope: "general",
    probes: [{ command: "startmeeting" }],
  },
};

function fake(probe: Probe): RepliableInteraction {
  const value = {
    customId:
      "button" in probe ? probe.button : "modal" in probe ? probe.modal : "",
    commandName:
      "command" in probe
        ? probe.command
        : "context" in probe
          ? probe.context
          : "",
    client: { user: { id: BOT_USER } },
    targetUser: { id: BOT_USER },
    isButton: () => "button" in probe,
    isModalSubmit: () => "modal" in probe,
    isChatInputCommand: () => "command" in probe,
    isUserContextMenuCommand: () => "context" in probe,
  };
  return value as unknown as RepliableInteraction;
}

test("every command module that reads the live session is classified", () => {
  const readers = readdirSync(COMMANDS_DIR).filter((file) =>
    /\bgetMeeting\(/.test(readFileSync(path.join(COMMANDS_DIR, file), "utf8")),
  );
  expect(readers.sort()).toEqual(Object.keys(LIVE_SESSION_READERS).sort());
});

test.each(Object.entries(LIVE_SESSION_READERS))(
  "%s is routed by its scope",
  (_file, { scope, probes }) => {
    for (const probe of probes)
      expect(resolveInteractionScope(fake(probe))).toBe(scope);
  },
);

test("Stop recording aimed at another user is general", () => {
  const interaction = {
    ...fake({ context: "Stop recording" }),
    targetUser: { id: "synthetic-someone-else" },
  };
  expect(
    resolveInteractionScope(interaction as unknown as RepliableInteraction),
  ).toBe("general");
});
