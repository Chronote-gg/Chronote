/** @jest-environment node */
/**
 * A /leave pressed while this worker is still starting the meeting goes the
 * whole way: the interaction writes the end request on the real lease, the
 * real renewal reads it, and the start ends the meeting once it exists.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { VoiceConnection } from "@discordjs/voice";
import { Collection, type RepliableInteraction } from "discord.js";
import { stopStartingSession } from "../../src/botStartingSessionStop";
import type { MeetingInitOptions } from "../../src/meetings";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import { createMeetingStart } from "../../src/services/meetingStart";
import type { MeetingData } from "../../src/types/meeting-data";
import { dismissalCancellationReason } from "../../src/utils/meetingLifecycle";
import { createLeaseTables } from "../repositories/meetingLeaseDynamo.fixture";
import {
  describeLocalDynamo,
  localDynamoClient,
} from "../repositories/workerRegistryDynamo.fixture";

const GUILD = "synthetic-start-stop-guild";
const MEETING = "synthetic-start-stop-meeting";
const USER = "synthetic-start-stop-user";
const AUTO_GUILD = "synthetic-start-dismiss-guild";
const AUTO_MEETING = "synthetic-start-dismiss-meeting";
const BUTTON_GUILD = "synthetic-start-button-guild";
const BUTTON_MEETING = "synthetic-start-button-meeting";
const ENDED_REPLY = "The recording has ended. Notes will follow.";
const VOICE = "synthetic-voice";
const START_DEADLINE_MS = 30_000;

describeLocalDynamo("a stop pressed during a start", () => {
  const client = localDynamoClient();
  const realSend = DynamoDBClient.prototype.send;
  let harness: Awaited<ReturnType<typeof createLeaseTables>>;

  beforeAll(async () => {
    harness = await createLeaseTables(client);
    // The interaction side reads and writes the lease through db.ts; point it
    // at the same table, through the client that created it: DynamoDB Local
    // keeps a separate set of tables per region unless it is started shared.
    jest.spyOn(DynamoDBClient.prototype, "send").mockImplementation(function (
      this: DynamoDBClient,
      ...args: Parameters<DynamoDBClient["send"]>
    ) {
      const input: { TableName?: string } = args[0].input;
      if (!input.TableName?.endsWith("ActiveMeetingTable"))
        return Reflect.apply(realSend, this, args);
      input.TableName = harness.tables.activeMeeting;
      return Reflect.apply(realSend, client, args);
    } as never);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await harness.dispose?.();
    client.destroy();
  });

  /** Starts a meeting whose voice join is interrupted by `stop`, pressed against the real lease. */
  async function startInterruptedBy(
    stop: (guildId: string, meetingId: string) => Promise<void>,
    session: { guildId: string; meetingId: string; isAutoRecording: boolean },
  ) {
    let renewal: (() => Promise<void>) | undefined;
    const lease = createMeetingLeaseService({
      repository: harness.repository,
      instanceId: () => "synthetic-start-stop-worker",
      nowMs: Date.now,
      schedule(run) {
        renewal = run;
        return () => {
          renewal = undefined;
        };
      },
    });
    const meeting = {
      meetingId: session.meetingId,
      guildId: session.guildId,
      isAutoRecording: session.isAutoRecording,
      finished: false,
      finishing: false,
      participants: new Map(),
      onEndMeeting: jest.fn(),
    } as unknown as MeetingData;
    const endMeeting = jest.fn();
    const start = createMeetingStart({
      lease,
      history: { transitionMeetingHistory: async () => "applied" },
      requestCaptureProtection: async () => undefined,
      releaseCaptureProtection: () => undefined,
      joinVoice: async () => {
        await stop(session.guildId, session.meetingId);
        await renewal!();
        return {} as VoiceConnection;
      },
      leaveVoice: () => undefined,
      dropVoiceLocally: () => undefined,
      buildMeetingSession: async () => meeting,
      disposeFailedSession: async () => true,
      startDeadline: () => AbortSignal.timeout(START_DEADLINE_MS),
      captureEndHandlers: () => ({
        onLost: () => undefined,
        onCapReached: () => undefined,
      }),
      endMeeting,
      indexMeeting: async () => undefined,
      nowMs: Date.now,
    });
    const options: Partial<MeetingInitOptions> = {
      meetingId: session.meetingId,
      sessionMode: "meeting",
      isAutoRecording: session.isAutoRecording,
      guild: { id: session.guildId } as never,
      voiceChannel: { id: VOICE, name: "Voice" } as never,
      textChannel: { id: "synthetic-text" } as never,
      creator: { id: USER } as never,
      startTriggeredByUserId: USER,
      transcribeMeeting: true,
      generateNotes: true,
    };
    await start.startMeetingSession(options as MeetingInitOptions);
    return { meeting, endMeeting };
  }

  const responses = () => ({
    deferReply: jest.fn(async () => undefined),
    editReply: jest.fn(async () => undefined),
  });

  test("an end request made during a start is applied once the meeting exists", async () => {
    const leave = {
      user: { id: USER },
      guild: { members: { fetch: async () => null } },
      options: { getBoolean: () => true },
      isButton: () => false,
      isChatInputCommand: () => true,
      isUserContextMenuCommand: () => false,
      ...responses(),
    };
    const { meeting, endMeeting } = await startInterruptedBy(
      (guildId, meetingId) =>
        stopStartingSession(
          leave as unknown as RepliableInteraction,
          guildId,
          meetingId,
        ),
      { guildId: GUILD, meetingId: MEETING, isAutoRecording: false },
    );

    expect(leave.editReply).toHaveBeenCalledWith(
      "Chronote is still joining. The meeting will end as soon as it has started.",
    );
    expect(endMeeting).toHaveBeenCalledWith(meeting);
    expect(meeting.endReason).toBe("leave_command");
    expect(meeting.endTriggeredByUserId).toBe(USER);
    expect(meeting.cancelled).toBeUndefined();
  });

  test("an earlier meeting's End button pressed during a start queues no stop and gets the ended reply", async () => {
    const press = {
      user: { id: USER },
      guild: { members: { fetch: async () => null } },
      isButton: () => true,
      isChatInputCommand: () => false,
      isUserContextMenuCommand: () => false,
      reply: jest.fn(async () => undefined),
      ...responses(),
    };
    const { endMeeting } = await startInterruptedBy(
      (guildId, meetingId) =>
        stopStartingSession(
          press as unknown as RepliableInteraction,
          guildId,
          meetingId,
        ),
      {
        guildId: BUTTON_GUILD,
        meetingId: BUTTON_MEETING,
        isAutoRecording: false,
      },
    );

    expect(press.reply).toHaveBeenCalledWith({
      content: ENDED_REPLY,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    expect(press.deferReply).not.toHaveBeenCalled();
    expect(endMeeting).not.toHaveBeenCalled();
  });

  test("Stop recording during an auto-recording's start cancels it as a live dismissal does", async () => {
    const voiceMembers = new Collection([
      [USER, { id: USER, user: { id: USER, bot: false } }],
    ]);
    const dismiss = {
      user: { id: USER },
      guildId: AUTO_GUILD,
      guild: {
        members: { fetch: async () => null },
        channels: {
          cache: new Map([
            [VOICE, { isVoiceBased: () => true, members: voiceMembers }],
          ]),
        },
      },
      isButton: () => false,
      isChatInputCommand: () => false,
      isUserContextMenuCommand: () => true,
      ...responses(),
    };
    const { meeting, endMeeting } = await startInterruptedBy(
      (guildId, meetingId) =>
        stopStartingSession(
          dismiss as unknown as RepliableInteraction,
          guildId,
          meetingId,
        ),
      { guildId: AUTO_GUILD, meetingId: AUTO_MEETING, isAutoRecording: true },
    );

    expect(endMeeting).toHaveBeenCalledWith(meeting);
    // The fields the dismissed auto-record completion rule reads.
    expect(meeting).toMatchObject({
      endReason: "dismissed",
      cancelled: true,
      cancellationReason: dismissalCancellationReason(USER),
      endTriggeredByUserId: USER,
    });
  });
});
