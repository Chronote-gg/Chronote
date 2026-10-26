import {
  generatedRuntimeProtection,
  completeGeneratedHistory,
} from "./fixtures/runtimeFixtureHelpers";
import { introductionFixture } from "../fixtures/productionIntroduction";
jest.mock("@aws-sdk/client-dynamodb", () =>
  jest
    .requireActual("./fixtures/loopbackDynamoMock")
    .createLoopbackDynamoMock(),
);
jest.mock("../../src/services/configService", () => {
  process.env.DDB_TABLE_PREFIX = `fixture-command-${jest.requireActual("node:crypto").randomUUID()}-`;
  return jest.requireActual("../../src/services/configService");
});
jest.mock("../../src/services/runtimeLifecycleService", () =>
  jest.requireActual("./fixtures/runtimeModuleMock").createRuntimeModuleMock(),
);
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "old",
}));
import { createMeetingStartDiscordFixture } from "../fixtures/meetingStart";
import {
  DeleteTableCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { Message, PermissionFlagsBits } from "discord.js";
import { randomUUID } from "node:crypto";
import { createRecoveryFaultDatabase } from "./fixtures/recordingRecoveryFaultFixture";
import { config } from "../../src/services/configService";
import * as database from "../../src/db";
import { control, runtime, history, promotion } from "./controlFixtures";
import { buildFixtureStartTransaction } from "../../src/services/productionFixtureCommandService";
import { getMeetingControlCommandRepository } from "../../src/repositories/meetingControlCommandRepository";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import {
  beginRuntimeWork,
  getRuntimeAdmissionContext,
  createRuntimeLifecycle,
} from "../../src/services/runtimeLifecycleService";
import {
  tryAcquireMeetingLease,
  attachMeetingReservation,
  releaseSessionReservation,
  getOwnedSessionReservations,
} from "../../src/services/activeMeetingLeaseService";
import { getMeeting, initializeMeeting } from "../../src/meetings";
import { runOwnedMeetingFinalization } from "../../src/services/meetingFinalizationService";
import type { FixtureGrant } from "../../src/types/productionIntroduction";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import type { MeetingData } from "../../src/types/meeting-data";
const prefix = config.database.tablePrefix;
const db = createRecoveryFaultDatabase({
  deploymentControl: `${prefix}DeploymentControlTable`,
  meetingHistory: `${prefix}MeetingHistoryTable`,
  activeMeeting: `${prefix}ActiveMeetingTable`,
});
const tables = {
  ...db.tables,
  meetingControlCommand: `${prefix}MeetingControlCommandTable`,
};
const discord = createMeetingStartDiscordFixture();
const maintenance = { holdId: "hold", introductionId: "intro", revision: 1 };
const hold = introductionFixture(maintenance);
const now = () => Math.floor(Date.now() / 1000);
let lifecycle: ReturnType<typeof createRuntimeLifecycle>;
function fixture() {
  const requestId = `fixture:${randomUUID()}`;
  const command: MeetingControlCommand = {
    requestId,
    userId: discord.creator.id,
    commandType: "start_meeting",
    input: {
      serverId: discord.guild.id,
      voiceChannelId: discord.voice.id,
      textChannelId: discord.notes.id,
    },
    queueStatus: "pending",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: now() + 600,
  };
  const grant: FixtureGrant = {
    pk: `FIXTURE#${requestId}`,
    sk: "AUTHORITY",
    recordType: "fixture_grant",
    protocolVersion: 1,
    grantId: requestId,
    ...maintenance,
    commandId: requestId,
    meetingId: randomUUID(),
    guildId: discord.guild.id,
    voiceChannelId: discord.voice.id,
    textChannelId: discord.notes.id,
    actorUserId: discord.creator.id,
    inputProfile: "manual_script_v1",
    scriptSha256: "a".repeat(64),
    checklistSha256: "b".repeat(64),
    sessionMode: "meeting",
    state: "issued",
  };
  return { command, grant };
}
function resetDiscord() {
  const { fetchChannel, send } = discord.resetStart({
    published: Reflect.construct(Message, [
      discord.client,
      {
        id: "message",
        channel_id: discord.notes.id,
        author: { id: discord.bot.id, username: "Chronote" },
        timestamp: new Date().toISOString(),
      },
    ]),
    notesPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    selectDestination: () => discord.notes.id,
  });
  fetchChannel.mockImplementation(async (id: string) =>
    id === discord.voice.id ? discord.voice : discord.notes,
  );
  return { fetchChannel, send };
}
beforeAll(async () => {
  await db.start();
  await db.createTable(tables.meetingControlCommand, ["requestId"]);
  jest
    .spyOn(database, "getDeploymentControlRepository")
    .mockReturnValue(db.repository);
});
afterAll(async () => {
  await db.client.send(
    new DeleteTableCommand({ TableName: tables.meetingControlCommand }),
  );
  await db.close();
});
beforeEach(async () => {
  jest.clearAllMocks();
  await db.put(tables.deploymentControl, {
    ...control,
    maintenance,
    coordinatorExpiresAt: now() + 600,
  });
  await db.put(tables.deploymentControl, hold);
  const member = runtime("old");
  member.readiness.expiresAt = now() + 600;
  member.protection.expiresAt = now() + 600;
  await db.put(tables.deploymentControl, member);
  const protection = generatedRuntimeProtection(member.identity, now);
  await protection.start();
  lifecycle = createRuntimeLifecycle({
    identity: member.identity,
    repository: db.repository,
    protection,
    now,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  await lifecycle.refreshRuntimeReadiness();
  jest.mocked(beginRuntimeWork).mockImplementation(lifecycle.beginRuntimeWork);
  jest
    .mocked(getRuntimeAdmissionContext)
    .mockImplementation(lifecycle.getRuntimeAdmissionContext);
});
afterEach(() => lifecycle.stop());
test("concurrent issuance preserves a bounded discovery list and atomically refuses stale replay", async () => {
  const first = fixture(),
    second = fixture();
  const results = await Promise.allSettled(
    [first, second].map(({ command, grant }) =>
      db.client.send(
        new TransactWriteItemsCommand(
          buildFixtureStartTransaction({ hold, grant, command, tables }),
        ),
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const stored = await db.repository.getRecord("ENV", "INTRODUCTION");
  if (stored?.recordType !== "production_introduction")
    throw new Error("missing introduction");
  expect(stored.fixtureGrantIds).toHaveLength(1);
  const loser =
    stored.fixtureGrantIds?.[0] === first.grant.grantId ? second : first;
  expect(
    await getMeetingControlCommandRepository().getCommand(
      loser.command.requestId,
    ),
  ).toBeUndefined();
  await db.client.send(
    new TransactWriteItemsCommand(
      buildFixtureStartTransaction({ hold: stored, ...loser, tables }),
    ),
  );
  const full = await db.repository.getRecord("ENV", "INTRODUCTION");
  if (full?.recordType !== "production_introduction")
    throw new Error("missing introduction");
  expect(full.fixtureGrantIds).toHaveLength(2);
  expect(() =>
    buildFixtureStartTransaction({ hold: full, ...fixture(), tables }),
  ).toThrow();
  await expect(
    db.client.send(
      new TransactWriteItemsCommand(
        buildFixtureStartTransaction({ hold, ...first, tables }),
      ),
    ),
  ).rejects.toThrow();
});
test("private worker resolves and consumes exact authority before voice and retains owner controls through a held handoff", async () => {
  const { command, grant } = fixture();
  await db.client.send(
    new TransactWriteItemsCommand(
      buildFixtureStartTransaction({ hold, grant, command, tables }),
    ),
  );
  const { send } = resetDiscord();
  let meeting: MeetingData | undefined;
  jest.mocked(initializeMeeting).mockImplementation(async (options) => {
    const acquired = await tryAcquireMeetingLease({
      scope: options.scope,
      guildId: options.guild.id,
      meetingId: options.meetingId!,
      voiceChannelId: options.voiceChannel.id,
      textChannelId: options.textChannel.id,
      startTriggeredByUserId: options.startTriggeredByUserId,
      isAutoRecording: false,
      sessionMode: "meeting",
      reservedAt: Date.now(),
      history: {
        ...history,
        guildId: options.guild.id,
        meetingId: options.meetingId!,
        channelId: options.voiceChannel.id,
      },
    });
    if (acquired.kind !== "admitted") throw new Error(acquired.reason);
    meeting = {
      guildId: discord.guild.id,
      meetingId: acquired.reservation.meetingId,
      creator: discord.creator,
      voiceChannel: discord.voice,
      textChannel: discord.notes,
      startTime: new Date(),
      reservation: acquired.reservation,
    } as MeetingData;
    attachMeetingReservation(meeting, acquired.reservation);
    return meeting;
  });
  await processMeetingControlCommand(discord.client, command);
  expect(
    await getMeetingControlCommandRepository().getCommand(command.requestId),
  ).toMatchObject({
    queueStatus: "completed",
    result: { meetingId: grant.meetingId },
  });
  expect(await db.repository.getRecord(grant.pk, grant.sk)).toMatchObject({
    state: "consumed",
    ownership: { meetingId: grant.meetingId, ownerInstanceId: "old" },
  });
  expect(send).toHaveBeenCalledTimes(1);
  if (!meeting) throw new Error("worker did not create meeting");
  const owned = meeting;
  const replacement = runtime("new", "candidate");
  replacement.readiness.expiresAt = now() + 600;
  replacement.protection.expiresAt = now() + 600;
  await db.put(tables.deploymentControl, replacement);
  expect(await db.repository.promote({ ...promotion, now: now() })).toBe(
    "applied",
  );
  await lifecycle.refreshRuntimeReadiness();
  expect(lifecycle.isAcceptingWork()).toBe(false);
  jest.mocked(getMeeting).mockReturnValue(owned);
  owned.onEndMeeting = async () => {
    await runOwnedMeetingFinalization(owned, async () => {
      if (owned.reservation?.sessionMode !== "meeting")
        throw new Error("missing reservation");
      const proof = {
        key: owned.reservation.historyKey,
        expectedMeetingId: owned.meetingId,
        expectedOwnerInstanceId: "old",
        expectedExecutionVersion: 1,
      };
      await completeGeneratedHistory(db.repository, proof);
      const completed = await db.repository.getMeetingHistory(proof.key);
      expect(completed?.contentRevision ?? 0).toBe(0);
      for (const field of [
        "updateDelivery",
        "publicationRepair",
        "contentMutation",
      ] as const)
        expect(completed?.[field]).toBeUndefined();
      if (!owned.finalization) throw new Error("missing finalization");
      owned.finalization.disposition = "durable";
      expect(await releaseSessionReservation(owned.reservation)).toBe(true);
    });
  };
  const stop: MeetingControlCommand = {
    ...command,
    requestId: randomUUID(),
    commandType: "stop_meeting",
    input: { serverId: discord.guild.id, meetingId: owned.meetingId },
    targetOwnerInstanceId: "old",
  };
  await getMeetingControlCommandRepository().writeCommand(stop);
  await processMeetingControlCommand(discord.client, stop);
  const stopped = await getMeetingControlCommandRepository().getCommand(
    stop.requestId,
  );
  if (stopped?.error) throw new Error(stopped.error);
  expect(stopped).toMatchObject({
    queueStatus: "completed",
    result: { status: "ended" },
  });
  expect(getOwnedSessionReservations()).toHaveLength(0);
  expect(lifecycle.getWorkCounts().finalization).toBe(0);
});

test.each(["manual_command", "auto_channel", "mcp", "tts_only"] as const)(
  "held ordinary %s initialization refuses before voice effects",
  async (start) => {
    const actual =
      jest.requireActual<typeof import("../../src/meetings")>(
        "../../src/meetings",
      );
    const previous = await db.repository.getRecord(
      `VOICE#${discord.guild.id}`,
      "STATE",
    );
    await expect(
      actual.initializeMeeting({
        meetingId: randomUUID(),
        guild: discord.guild,
        voiceChannel: discord.voice,
        textChannel: discord.notes,
        creator: discord.creator,
        transcribeMeeting: true,
        generateNotes: true,
        sessionMode: start === "tts_only" ? "tts_only" : "meeting",
        isAutoRecording: start === "auto_channel",
        startReason: start === "tts_only" ? "manual_command" : start,
        startTriggeredByUserId: discord.creator.id,
      }),
    ).rejects.toThrow("admission blocked");
    expect(
      await db.repository.getRecord(`VOICE#${discord.guild.id}`, "STATE"),
    ).toEqual(previous);
  },
);
test.each(["copied", "destination", "released"] as const)(
  "private worker refuses %s fixture authority before start effects",
  async (fault) => {
    const { command, grant } = fixture();
    if (fault === "destination") {
      command.input = { ...command.input, textChannelId: "previous-notes" };
      grant.textChannelId = "previous-notes";
    }
    await db.client.send(
      new TransactWriteItemsCommand(
        buildFixtureStartTransaction({ hold, grant, command, tables }),
      ),
    );
    const { send } = resetDiscord();
    jest.mocked(initializeMeeting).mockClear();
    let attempted = command;
    if (fault === "copied") {
      attempted = { ...command, requestId: `fixture:${randomUUID()}` };
      await db.put(tables.meetingControlCommand, attempted);
    }
    if (fault === "released") await db.put(tables.deploymentControl, control);
    await processMeetingControlCommand(discord.client, attempted);
    expect(initializeMeeting).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await db.repository.getRecord(grant.pk, grant.sk)).toMatchObject({
      state: "issued",
    });
    expect(
      await getMeetingControlCommandRepository().getCommand(
        attempted.requestId,
      ),
    ).toMatchObject({
      queueStatus: fault === "destination" ? "failed" : "pending",
    });
  },
);
