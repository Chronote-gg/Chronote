import type * as MeetingFinish from "../../../src/services/meetingFinish";
import type * as MeetingFinishInput from "../../../src/services/meetingFinishInput";
import type * as MeetingFinishRepository from "../../../src/repositories/meetingFinishRepository";
import type { FinishInput } from "../../../src/services/meetingFinishInput";
import type { MeetingHistory } from "../../../src/types/db";
import { installWorkerSeams, type World, type WorkerSeams } from "./world";

const MS_PER_SECOND = 1000;

export const FINISH_GUILD_ID = "200000000000000011";
export const FINISH_TEXT_CHANNEL_ID = "200000000000000012";
export const FINISH_VOICE_CHANNEL_ID = "200000000000000013";
export const FINISH_SPEAKER = {
  id: "300000000000000011",
  username: "Speaker A",
};
const MEETING_SECONDS = 1800;
/** Relative to the run: a fixed date would age past the finisher's 24 hour rule and the loop would abandon the rows. */
export const FINISH_START = new Date(
  Date.now() - 2 * MEETING_SECONDS * MS_PER_SECOND,
).toISOString();

export function addFinishChannels(world: World): void {
  world.discord.addGuild(FINISH_GUILD_ID);
  world.discord.addChannel({
    id: FINISH_TEXT_CHANNEL_ID,
    guildId: FINISH_GUILD_ID,
    name: "notes",
    kind: "text",
  });
  world.discord.addChannel({
    id: FINISH_VOICE_CHANNEL_ID,
    guildId: FINISH_GUILD_ID,
    name: "Voice",
    kind: "voice",
  });
  world.discord.addMember(FINISH_GUILD_ID, FINISH_SPEAKER);
}

/** A lifecycle version 2 row in one scenario server, keyed by its meeting id. */
export function finishRow(
  meetingId: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory {
  return {
    lifecycleVersion: 2,
    executionVersion: 1,
    ownerInstanceId: "scenario-worker-starter",
    guildId: FINISH_GUILD_ID,
    channelId_timestamp: `${FINISH_VOICE_CHANNEL_ID}#${meetingId}`,
    meetingId,
    channelId: FINISH_VOICE_CHANNEL_ID,
    textChannelId: FINISH_TEXT_CHANNEL_ID,
    timestamp: FINISH_START,
    participants: [FINISH_SPEAKER],
    duration: MEETING_SECONDS,
    transcribeMeeting: true,
    generateNotes: true,
    meetingCreatorId: FINISH_SPEAKER.id,
    status: "processing",
    capture: {
      kind: "complete",
      startedAt: FINISH_START,
      endedAt: new Date(
        Date.parse(FINISH_START) + MEETING_SECONDS * MS_PER_SECOND,
      ).toISOString(),
    },
    ...overrides,
  };
}

/** What a loader produces for a meeting that recorded one speaker saying `transcript`. */
export function spokenInput(
  row: MeetingHistory,
  transcript: string,
): FinishInput {
  return {
    source: "recovery",
    transcript,
    transcriptUpload: {
      key: `scenario/${row.meetingId}/transcript.json`,
      body: Buffer.from(JSON.stringify({ text: transcript })),
    },
    processing: { transcription: "ready" },
    participants: row.participants,
    hasSavedAudio: true,
    notesInput: {
      meetingId: row.meetingId,
      guildId: row.guildId,
      channelId: row.channelId,
      generateNotes: true,
      transcribeMeeting: true,
      startTime: new Date(row.timestamp),
      finalTranscript: transcript,
      processing: { transcription: "ready" },
      tags: [],
      participants: new Map(row.participants.map((p) => [p.id, p])),
      attendance: new Set(row.participants.map((p) => `<@${p.id}>`)),
      creator: { id: FINISH_SPEAKER.id },
      guild: { id: row.guildId, name: "Scenario Guild", description: "" },
      voiceChannel: { id: row.channelId, name: "Voice" },
      // Loaders prepare the notes prompt; the model call itself goes to the OpenAI fake.
      notesPrompt: {
        messages: [
          { role: "system", content: "Write meeting notes." },
          { role: "user", content: transcript },
        ],
        source: "langfuse",
        promptVisibleRoleIds: [],
      },
    },
  };
}

export type FinishWorker = {
  seams: WorkerSeams;
  finish: typeof MeetingFinish;
  input: typeof MeetingFinishInput;
  /**
   * Claims the row the way the finisher loop would. A retry is claimable once
   * its time arrives, so the claim clock jumps there instead of waiting.
   */
  claim(
    row: MeetingHistory,
  ): ReturnType<
    ReturnType<
      typeof MeetingFinishRepository.getMeetingFinishRepository
    >["claim"]
  >;
  adopt: ReturnType<
    typeof MeetingFinishRepository.getMeetingFinishRepository
  >["adopt"];
  run<T>(work: () => Promise<T>): Promise<T>;
};

/** One worker's finish pipeline, imported in isolation behind that worker's seams. */
export function startFinishWorker(
  world: World,
  instanceId: string,
): Promise<FinishWorker> {
  return new Promise((resolve, reject) => {
    jest
      .isolateModulesAsync(async () => {
        const seams = installWorkerSeams(world, { instanceId, release: 1 });
        const [finish, input, bindings] = await seams.run(() =>
          Promise.all([
            import("../../../src/services/meetingFinish"),
            import("../../../src/services/meetingFinishInput"),
            import("../../../src/repositories/meetingFinishRepository"),
          ]),
        );
        const repository = bindings.getMeetingFinishRepository();
        resolve({
          seams,
          finish,
          input,
          claim: (row) => {
            const now = Math.floor(Date.now() / MS_PER_SECOND);
            const due = Math.max(
              row.finish?.nextAttemptAt ?? now,
              (row.finish?.expiresAt ?? now - 1) + 1,
              now,
            );
            return seams.run(() => repository.claim(row, instanceId, due));
          },
          adopt: (row, owner, derived, now) =>
            seams.run(() => repository.adopt(row, owner, derived, now)),
          run: (work) => seams.run(work),
        });
      })
      .catch(reject);
  });
}

export async function onlyRow(world: World): Promise<MeetingHistory> {
  const [row] = await world.rows.history(FINISH_GUILD_ID);
  if (!row) throw new Error("expected the scenario meeting row");
  return row;
}
