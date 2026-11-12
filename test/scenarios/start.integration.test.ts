/** @jest-environment node */
import { EventEmitter } from "node:events";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type * as DiscordVoice from "@discordjs/voice";
import { createLeaseTables } from "../repositories/meetingLeaseDynamo.fixture";
import {
  describeLocalDynamo,
  localDynamoClient,
} from "../repositories/workerRegistryDynamo.fixture";
import { createDynamoMeetingHistoryTransitionRepository } from "../../src/repositories/meetingHistoryTransitions";
import {
  buildMeetingSession,
  disposeFailedInitialization,
  type MeetingInitOptions,
} from "../../src/meetings";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import { createMeetingStart } from "../../src/services/meetingStart";
import { joinVoice, leaveVoice } from "../../src/services/voiceSession";

/**
 * The harness's FakeVoice connections are Ready on creation, so they cannot
 * model a join that never becomes Ready. This local voice fake can, and keeps
 * the harness's departure record: a leave versus a local drop.
 */
const voice = {
  readyOnJoin: true,
  departures: [] as Array<"leave" | "local_drop">,
};
jest.mock("@discordjs/voice", () => {
  const actual = jest.requireActual<typeof DiscordVoice>("@discordjs/voice");
  class ScenarioConnection extends EventEmitter {
    state = {
      status: voice.readyOnJoin
        ? actual.VoiceConnectionStatus.Ready
        : actual.VoiceConnectionStatus.Signalling,
    };
    destroy(adapterAvailable = true) {
      this.state = { status: actual.VoiceConnectionStatus.Destroyed };
      voice.departures.push(adapterAvailable ? "leave" : "local_drop");
    }
  }
  return {
    ...actual,
    joinVoiceChannel: () => new ScenarioConnection(),
  };
});

const GUILD = "synthetic-guild";
const VOICE_CHANNEL = "synthetic-voice";
// Long enough that the lease and protection writes finish before it under load: a deadline that fires before the join sends no join, so there is no leave to see.
const SCENARIO_START_DEADLINE_MS = 2_000;

function startOptions(meetingId: string, send: jest.Mock): MeetingInitOptions {
  const partial: Partial<MeetingInitOptions> = {
    meetingId,
    voiceChannel: { id: VOICE_CHANNEL, name: "Voice" } as never,
    textChannel: { id: "synthetic-text", send } as never,
    guild: { id: GUILD, voiceAdapterCreator: () => ({}) } as never,
    creator: { id: "synthetic-user" } as never,
    transcribeMeeting: true,
    generateNotes: true,
  };
  return partial as MeetingInitOptions;
}

describeLocalDynamo("start scenarios against local Dynamo", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  beforeEach(() => {
    voice.readyOnJoin = true;
    voice.departures = [];
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  async function worker() {
    const tables = await createLeaseTables(client);
    const lease = createMeetingLeaseService({
      repository: tables.repository,
      instanceId: () => "synthetic-worker-a",
      nowMs: Date.now,
      schedule(run, delayMs) {
        const timer = setTimeout(() => void run(), delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      },
    });
    const build = jest.fn(buildMeetingSession);
    const start = createMeetingStart({
      lease,
      history: createDynamoMeetingHistoryTransitionRepository(client, {
        deploymentControl: tables.tables.deploymentControl,
        meetingHistory: tables.tables.meetingHistory,
        activeMeeting: tables.tables.activeMeeting,
      }),
      requestCaptureProtection: jest.fn(async () => undefined),
      releaseCaptureProtection: jest.fn(),
      joinVoice,
      leaveVoice,
      buildMeetingSession: build,
      disposeFailedSession: disposeFailedInitialization,
      startDeadline: () => AbortSignal.timeout(SCENARIO_START_DEADLINE_MS),
      captureEndHandlers: () => ({
        onLost: jest.fn(),
        onCapReached: jest.fn(),
      }),
      endMeeting: jest.fn(),
      nowMs: Date.now,
    });
    return { tables, lease, build, start };
  }

  async function rowFor(
    tables: Awaited<ReturnType<typeof createLeaseTables>>,
    meetingId: string,
  ) {
    const reads = await client.send(
      new QueryCommand({
        TableName: tables.tables.meetingHistory,
        KeyConditionExpression: "guildId = :guild",
        ExpressionAttributeValues: { ":guild": { S: GUILD } },
        ConsistentRead: true,
      }),
    );
    return (reads.Items ?? [])
      .map((item) => unmarshall(item))
      .find((row) => row.meetingId === meetingId);
  }

  /** The server is free when a new start is admitted at once. */
  async function serverIsFree(world: Awaited<ReturnType<typeof worker>>) {
    expect(await world.tables.repository.read(GUILD)).toBeUndefined();
    const { lease } = world;
    const admission = await lease.acquireSessionLease({
      guildId: GUILD,
      meetingId: "synthetic-meeting-next",
      voiceChannelId: VOICE_CHANNEL,
      textChannelId: "synthetic-text",
      isAutoRecording: false,
      reservedAt: Date.now(),
      sessionMode: "tts_only",
    });
    expect(admission.kind).toBe("admitted");
    if (admission.kind === "admitted")
      await lease.releaseSessionLease(admission.reservation);
  }

  test("scenario 12: a start that never reaches receiving audio is abandoned at the deadline and the server is free", async () => {
    const world = await worker();
    try {
      voice.readyOnJoin = false;
      const send = jest.fn();
      const started = Date.now();

      await expect(
        world.start.startMeetingSession(
          startOptions("synthetic-meeting-a", send),
        ),
      ).rejects.toBeDefined();

      expect(Date.now() - started).toBeGreaterThanOrEqual(
        SCENARIO_START_DEADLINE_MS,
      );
      expect(world.build).not.toHaveBeenCalled();
      expect(voice.departures).toEqual(["leave"]);
      expect(await rowFor(world.tables, "synthetic-meeting-a")).toMatchObject({
        status: "failed",
        lifecycleVersion: 2,
        executionVersion: 1,
      });
      expect(send).not.toHaveBeenCalled();
      await serverIsFree(world);
    } finally {
      await world.tables.dispose();
    }
  });

  test("scenario 13: a start that dies before saving any audio ends silently", async () => {
    const world = await worker();
    try {
      const send = jest.fn();
      const death = new Error("synthetic worker failure before capture");
      world.build.mockRejectedValueOnce(death);

      await expect(
        world.start.startMeetingSession(
          startOptions("synthetic-meeting-b", send),
        ),
      ).rejects.toBe(death);

      expect(voice.departures).toEqual(["leave"]);
      expect(await rowFor(world.tables, "synthetic-meeting-b")).toMatchObject({
        status: "failed",
        lifecycleVersion: 2,
      });
      expect(send).not.toHaveBeenCalled();
      await serverIsFree(world);
    } finally {
      await world.tables.dispose();
    }
  });
});
