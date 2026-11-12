import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import * as DiscordJs from "discord.js";
import type * as DiscordVoice from "@discordjs/voice";
import type * as Db from "../../src/db";
import type * as LangfusePromptService from "../../src/services/langfusePromptService";
import type * as OpenAIClientModule from "../../src/services/openaiClient";
import type * as StorageService from "../../src/services/storageService";
import type { MeetingHistory } from "../../src/types/db";
import { createFakeClientClass } from "./harness/fakeDiscord";
import { createPromptModule } from "./harness/fakeOpenAI";
import { FakeVoice } from "./harness/fakeVoice";
import { scenarioDynamoConfig } from "./harness/tables";
import {
  createWorld,
  installWorkerSeams,
  WorkerGate,
  type World,
} from "./harness/world";

const GUILD_ID = "200000000000000001";
const TEXT_CHANNEL_ID = "200000000000000002";
const VOICE_CHANNEL_ID = "200000000000000003";
const SPEAKER = { id: "300000000000000001", username: "Speaker A" };
const FORBIDDEN = 403;
const CHANNEL_URL = `https://discord.com/api/v10/channels/${TEXT_CHANNEL_ID}`;
const TIMER_AFTER_KILL_MS = 50;

let world: World;

beforeAll(async () => {
  world = await createWorld();
  world.discord.addGuild(GUILD_ID);
  world.discord.addChannel({
    id: TEXT_CHANNEL_ID,
    guildId: GUILD_ID,
    name: "notes",
    kind: "text",
  });
  world.discord.addChannel({
    id: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    name: "Voice",
    kind: "voice",
  });
  world.discord.addMember(GUILD_ID, SPEAKER);
});

afterAll(async () => {
  await world.dispose();
});

function meetingRow(meetingId: string): MeetingHistory {
  return {
    guildId: GUILD_ID,
    channelId_timestamp: `${VOICE_CHANNEL_ID}#${meetingId}`,
    meetingId,
    channelId: VOICE_CHANNEL_ID,
    timestamp: "2026-11-11T00:00:00.000Z",
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
  };
}

test("tables exist under a private prefix", async () => {
  const prefix = process.env.DDB_TABLE_PREFIX ?? "";
  expect(prefix).toMatch(/^scenario-[0-9a-f-]{36}-$/);
  const client = new DynamoDBClient(scenarioDynamoConfig());
  const { TableNames = [] } = await client.send(
    new ListTablesCommand({ Limit: 100 }),
  );
  client.destroy();
  expect(TableNames).toEqual(
    expect.arrayContaining(
      [
        "MeetingHistoryTable",
        "ActiveMeetingTable",
        "DeploymentControlTable",
        "MeetingControlCommandTable",
      ].map((name) => prefix + name),
    ),
  );
  await world.seedLegacyRuntime(Math.floor(Date.now() / 1000));
  expect(await world.rows.history(GUILD_ID)).toEqual([]);
  expect(await world.rows.lease(GUILD_ID)).toBeUndefined();
  expect(await world.rows.registry()).toEqual({ workers: [], cutover: false });
});

test("REST fake records a post and replays a scripted failure", async () => {
  const ScenarioClient = createFakeClientClass(
    DiscordJs,
    world.discord,
    new WorkerGate("scenario-worker-rest"),
  );
  const client = new ScenarioClient({ intents: [] });
  const ready = new Promise((resolve) =>
    client.once(DiscordJs.Events.ClientReady, resolve),
  );
  await client.login();
  await ready;
  const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error("Text channel not cached");
  expect(client.guilds.cache.get(GUILD_ID)?.members.cache.has(SPEAKER.id)).toBe(
    true,
  );

  const sent = await channel.send("first");
  expect(world.discord.rest.posts()).toEqual([
    {
      method: "POST",
      path: `/channels/${TEXT_CHANNEL_ID}/messages`,
      body: expect.objectContaining({ content: "first" }),
    },
  ]);

  world.discord.rest.failNext(FORBIDDEN, 1);
  await expect(channel.send("rejected")).rejects.toMatchObject({
    status: FORBIDDEN,
  });
  await expect(channel.send("after")).resolves.toMatchObject({
    content: "after",
  });

  const readBack = await fetch(
    `https://discord.com/api/v10/channels/${TEXT_CHANNEL_ID}/messages/${sent.id}`,
  );
  expect(await readBack.json()).toMatchObject({ content: "first" });
  await client.destroy();
});

test("voice fake delivers audio to a subscriber", async () => {
  const voice = new FakeVoice(new WorkerGate("scenario-worker-voice"));
  const voiceModule = voice.createModule(
    jest.requireActual<typeof DiscordVoice>("@discordjs/voice"),
  );
  const connection = voiceModule.joinVoiceChannel({
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
  });
  const received: Buffer[] = [];
  connection.receiver.speaking.on("start", (userId: string) =>
    connection.receiver
      .subscribe(userId)
      .on("data", (chunk: Buffer) => received.push(chunk)),
  );
  const pcm = Buffer.from([1, 2, 3, 4]);

  await voice.speak(GUILD_ID, SPEAKER.id, pcm);
  expect(Buffer.concat(received)).toEqual(pcm);

  connection.destroy(false);
  expect(voice.departures).toEqual([{ guildId: GUILD_ID, kind: "local_drop" }]);
  expect(voiceModule.getVoiceConnection(GUILD_ID)).toBeUndefined();
});

test("object store round trip", async () => {
  const actual = jest.requireActual<typeof StorageService>(
    "../../src/services/storageService",
  );
  const writerGate = new WorkerGate("scenario-worker-writer");
  const writer = world.storage.createModule(actual, writerGate);
  const reader = world.storage.createModule(
    actual,
    new WorkerGate("scenario-worker-reader"),
  );
  const body = JSON.stringify({ synthetic: true });

  const reference = await writer.uploadVerifiedObjectToS3(
    "scenario/object.json",
    body,
    "application/json",
  );
  expect(reference).toMatchObject({ key: "scenario/object.json" });
  expect(await reader.fetchJsonFromS3("scenario/object.json")).toEqual({
    synthetic: true,
  });
  expect(
    Buffer.from(
      (await reader.fetchObjectBytesFromS3("scenario/object.json")) ?? [],
    ).toString("utf8"),
  ).toBe(body);

  writerGate.kill();
  await expect(
    writer.uploadObjectToS3("scenario/late.json", body, "application/json"),
  ).rejects.toThrow("was killed");
  expect(world.storage.objects.has("scenario/late.json")).toBe(false);
});

test("killed worker cannot write", async () => {
  const worker = await new Promise<{
    seams: ReturnType<typeof installWorkerSeams>;
    db: typeof Db;
  }>((resolve, reject) => {
    jest
      .isolateModulesAsync(async () => {
        const seams = installWorkerSeams(world, {
          instanceId: "scenario-worker-a",
          release: 1,
        });
        resolve({
          seams,
          db: await seams.run(() => import("../../src/db")),
        });
      })
      .catch(reject);
  });

  await worker.db.writeMeetingHistory(meetingRow("before-kill"));
  const readChannel = () => fetch(CHANNEL_URL).then((reply) => reply.json());
  await expect(worker.seams.run(readChannel)).resolves.toMatchObject({
    id: TEXT_CHANNEL_ID,
  });
  const scheduledBeforeKill = worker.seams.run(
    () =>
      new Promise((resolve, reject) =>
        setTimeout(
          () => readChannel().then(resolve, reject),
          TIMER_AFTER_KILL_MS,
        ),
      ),
  );
  worker.seams.network.block();
  const held = worker.db.writeMeetingHistory(meetingRow("held-write"));
  worker.seams.kill();
  await expect(held).rejects.toThrow("was killed");
  await expect(
    worker.db.writeMeetingHistory(meetingRow("after-kill")),
  ).rejects.toThrow("was killed");

  await expect(scheduledBeforeKill).rejects.toThrow("was killed");
  await expect(worker.seams.run(readChannel)).rejects.toThrow("was killed");
  await expect(readChannel()).resolves.toMatchObject({ id: TEXT_CHANNEL_ID });

  const rows = await world.rows.history(GUILD_ID);
  expect(rows.map((row) => row.meetingId)).toEqual(["before-kill"]);
});

test("REST fake throws on a route it does not implement", async () => {
  const ScenarioClient = createFakeClientClass(
    DiscordJs,
    world.discord,
    new WorkerGate("scenario-worker-routes"),
  );
  const client = new ScenarioClient({ intents: [] });
  await client.login();
  const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error("Text channel not cached");
  const before = world.discord.rest.requests().length;

  await expect(channel.sendTyping()).rejects.toThrow(
    `FakeRest does not implement POST /channels/${TEXT_CHANNEL_ID}/typing`,
  );
  await expect(fetch(`${CHANNEL_URL}/pins`)).rejects.toThrow(
    `FakeRest does not implement GET /channels/${TEXT_CHANNEL_ID}/pins`,
  );
  await expect(
    fetch(`${CHANNEL_URL}/messages/1/reactions/x/@me`, { method: "PUT" }),
  ).rejects.toThrow("FakeRest does not implement PUT");
  expect(world.discord.rest.requests()).toHaveLength(before);
  await client.destroy();
});

test("OpenAI and prompt fakes serve scripts and repo prompts", async () => {
  const gate = new WorkerGate("scenario-worker-openai");
  const client = world.openai
    .createModule(
      jest.requireActual<typeof OpenAIClientModule>(
        "../../src/services/openaiClient",
      ),
      gate,
    )
    .createOpenAIClient();
  world.openai.script("transcription", "Scripted words.");
  world.openai.failNext("text", 1, 429);

  await expect(
    client.audio.transcriptions.create({ model: "synthetic" }),
  ).resolves.toEqual({ text: "Scripted words." });
  await expect(client.responses.create({})).rejects.toMatchObject({
    status: 429,
  });
  await expect(client.responses.create({})).resolves.toMatchObject({
    status: "completed",
  });

  const prompts = createPromptModule(
    jest.requireActual<typeof LangfusePromptService>(
      "../../src/services/langfusePromptService",
    ),
  );
  const chat = await prompts.getLangfuseChatPrompt({
    name: "chronote-meeting-summary-chat",
    variables: { notes: "Synthetic scenario notes" },
  });
  expect(chat.messages[0]?.role).toBe("system");
  expect(chat.messages.map((message) => message.content).join("\n")).toContain(
    "Synthetic scenario notes",
  );
});
