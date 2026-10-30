/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { PermissionFlagsBits } from "discord.js";
import type { MeetingData } from "../src/types/meeting-data";
import {
  runMeetingNoticeMutation,
  stopMeetingProcessing,
  areMeetingNoticesSettled,
  getMeetingProcessingSignal,
} from "../src/services/meetingProcessingLifetime";
function load(allowed: boolean, setNickname: () => Promise<void>) {
  const file = path.join(__dirname, "../src/meetings.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["applyVoiceSessionNickname", "buildVoiceSessionNickname"].includes(
        node.name?.text ?? "",
      ),
  );
  expect(selected).toHaveLength(2);
  const meeting = {
    guildId: "guild",
    voiceChannel: { id: "voice" },
    reservation: {},
    guild: {
      members: {
        me: {
          nickname: null,
          displayName: "Chronote",
          permissions: { has: () => allowed },
          setNickname,
        },
      },
    },
  } as unknown as MeetingData;
  const context = vm.createContext({
    meeting,
    signal: new AbortController().signal,
    runMeetingNoticeMutation,
    getMeetingProcessingSignal,
    PermissionFlagsBits,
    DISCORD_NICKNAME_MAX_LENGTH: 32,
    CONFIG_KEYS: { chatTts: {} },
    resolveConfigSnapshot: async () => ({}),
    getSnapshotBoolean: () => true,
    getSnapshotString: () => "Recording",
    console: { warn: jest.fn() },
  });
  vm.runInContext(
    ts.transpileModule(
      selected.map((node) => node.getText(source)).join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  return {
    meeting,
    run: (): Promise<void> =>
      vm.runInContext("applyVoiceSessionNickname(meeting, signal)", context),
  };
}
test("known missing nickname permission skips the mutation and preserves recording admission", async () => {
  const mutation = jest.fn(async () => {});
  const f = load(false, mutation);
  await f.run();
  expect(mutation).not.toHaveBeenCalled();
  expect(areMeetingNoticesSettled(f.meeting, f.meeting.reservation)).toBe(true);
});
test("a final HTTP rejection cannot erase uncertainty from hidden earlier REST retries", async () => {
  const f = load(true, async () => {
    throw Object.assign(new Error("final forbidden after a possible reset"), {
      status: 403,
    });
  });
  await expect(f.run()).rejects.toThrow("Meeting notice outcome is unknown");
  expect(areMeetingNoticesSettled(f.meeting, f.meeting.reservation)).toBe(
    false,
  );
});
test("a late nickname acknowledgment remains owned until the actual mutation and flag update finish", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const f = load(true, () => pending);
  const changing = f.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  let settled = false;
  const drain = stopMeetingProcessing(f.meeting).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  complete();
  await expect(changing).rejects.toThrow("Meeting processing interrupted");
  await drain;
  expect(f.meeting.botNicknameChanged).toBe(true);
});
