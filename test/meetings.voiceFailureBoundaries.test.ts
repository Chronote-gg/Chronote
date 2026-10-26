/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { DiscordAPIError } from "discord.js";
import type { MeetingData } from "../src/types/meeting-data";
import {
  runMeetingNoticeMutation,
  areMeetingNoticesSettled,
  stopMeetingProcessing,
} from "../src/services/meetingProcessingLifetime";

function loadConnectionBoundary(send: () => Promise<void>) {
  const file = path.join(__dirname, "../src/meetings.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const registrations: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "connection" &&
      node.expression.name.text === "on" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "error"
    )
      registrations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(registrations).toHaveLength(1);
  const connection = new EventEmitter();
  const warn = jest.fn();
  const textChannel = { send: jest.fn(send) };
  const meeting = { meetingId: "synthetic-meeting" } as MeetingData;
  const context = vm.createContext({
    connection,
    textChannel,
    isAutoRecording: false,
    meeting,
    runMeetingNoticeMutation,
    DiscordAPIError,
    console: { warn, error: jest.fn() },
  });
  vm.runInContext(
    ts.transpileModule(registrations[0].getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return { connection, textChannel, warn, meeting };
}

test("a rejected connection-error notification is consumed once without another notification", async () => {
  const { connection, textChannel, warn } = loadConnectionBoundary(async () => {
    throw new Error("private notification detail");
  });
  connection.emit("error", new Error("synthetic connection fault"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(textChannel.send).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls).toEqual([
    [
      "Voice error notification failed:",
      {
        stage: "connection-error-notification",
        meetingId: "synthetic-meeting",
      },
    ],
  ]);
});

test("a delivered connection-error notification does not log a failure", async () => {
  const { connection, textChannel, warn } = loadConnectionBoundary(
    async () => {},
  );
  connection.emit("error", new Error("synthetic connection fault"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(textChannel.send).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

test("initial meeting setup still awaits and rejects a failed subscription", async () => {
  const file = path.join(__dirname, "../src/meetings.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "initializeReservedMeeting",
  );
  if (!declaration) throw new Error("Missing reserved meeting initializer");
  const failure = new Error("synthetic initial subscription failure");
  const connection = Object.assign(new EventEmitter(), { receiver: {} });
  const signal = new AbortController().signal;
  const context = vm.createContext({
    joinOwnedVoiceSession: async () => connection,
    getReservationSignal: () => signal,
    attachMeetingReservation: jest.fn(),
    resolveMeetingRuntimeConfig: async () => undefined,
    freezeCompletionPolicy: jest.fn(),
    config: { liveVoice: { mode: "off" } },
    MEETING_START_REASONS: { MANUAL_COMMAND: "manual" },
    DEFAULT_PREFIX_MODE: "none",
    uuidv4: () => "synthetic-meeting",
    openOutputFile: jest.fn(),
    buildParticipantSnapshot: async () => undefined,
    runMeetingNoticeMutation,
    DiscordAPIError,
    subscribeToUserVoice: async () => {
      throw failure;
    },
    options: {
      guild: { id: "synthetic-guild" },
      creator: { id: "synthetic-user" },
      textChannel: { id: "synthetic-text" },
      voiceChannel: {
        id: "synthetic-voice",
        guild: {},
        members: [{ user: { id: "synthetic-user" } }],
      },
      reservation: {
        reservedAt: Date.now(),
        ownerInstanceId: "synthetic-owner",
      },
      initialization: { cleanup: [] },
    },
  });
  vm.runInContext(
    ts.transpileModule(declaration.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  await expect(
    vm.runInContext("initializeReservedMeeting(options)", context),
  ).rejects.toBe(failure);
});

test.each(["acknowledged", "rejected", "unknown"] as const)(
  "connection-error notification keeps its issued lifetime and %s outcome after fencing",
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const { connection, textChannel, warn, meeting } = loadConnectionBoundary(
      () => pending,
    );
    connection.emit("error", new Error("synthetic connection fault"));
    expect(areMeetingNoticesSettled(meeting, meeting.reservation)).toBe(false);
    let settled = false;
    const stop = stopMeetingProcessing(meeting).then(() => {
      settled = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    if (outcome === "acknowledged") resolve();
    else if (outcome === "rejected")
      reject(
        new DiscordAPIError(
          { code: 50013, message: "Synthetic denied" },
          50013,
          403,
          "POST",
          "http://localhost",
          { body: {}, files: [] },
        ),
      );
    else reject(new Error("Synthetic lost notification ACK"));
    await stop;
    await new Promise<void>((done) => setImmediate(done));
    expect(areMeetingNoticesSettled(meeting, meeting.reservation)).toBe(
      outcome !== "unknown",
    );
    expect(textChannel.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(outcome === "acknowledged" ? 0 : 1);
    connection.emit("error", new Error("synthetic late connection fault"));
    await new Promise<void>((done) => setImmediate(done));
    expect(textChannel.send).toHaveBeenCalledTimes(1);
  },
);
