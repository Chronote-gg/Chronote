import { renderMeetingDelivery } from "../../../src/services/meetingDelivery";
import type { MeetingHistory } from "../../../src/types/db";
import { NOTES } from "../../services/meetingDelivery.fixture";
import {
  addFinishChannels,
  FINISH_TEXT_CHANNEL_ID,
  finishRow,
} from "./finisher";
import { createWorld, type World } from "./world";

/**
 * Registers the per-test world for a finish scenario file: a fresh world with
 * the finish channels, quiet console, and disposal afterwards. `onCreate`
 * receives each new world before its test runs.
 */
export function useFinishWorld(onCreate: (world: World) => void): void {
  let world: World | undefined;
  beforeEach(async () => {
    world = await createWorld();
    addFinishChannels(world);
    onCreate(world);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await world?.dispose();
  });
}

/** Messages posted to the finish text channel. */
export const finishChannelMessages = (world: World) =>
  [...world.discord.rest.messages.values()].filter(
    (message) => message.channel_id === FINISH_TEXT_CHANNEL_ID,
  );

function finishChannelTitles(world: World): string[] {
  return finishChannelMessages(world).map((message) => {
    const [embed] = message.embeds;
    return embed && typeof embed === "object" && "title" in embed
      ? String(embed.title)
      : "";
  });
}

/** Kills a worker while it answers its `count`th POST; `refuse` also fails that POST. */
export function killOnPost(
  world: World,
  kill: () => void,
  count: number,
  refuse: boolean,
): () => boolean {
  let posts = 0;
  let armed = true;
  world.discord.rest.onPost(() => {
    if (!armed || ++posts < count) return;
    armed = false;
    kill();
    if (refuse) throw new Error("Scenario worker died before posting");
  });
  return () => !armed;
}

/** A meeting whose terminal status and notes were saved before delivery began. */
export function savedMeeting(
  meetingId: string,
  overrides: Partial<MeetingHistory> = {},
) {
  return finishRow(meetingId, {
    status: "complete",
    notes: NOTES,
    summarySentence: "Synthetic summary.",
    summaryLabel: "Synthetic label",
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    transcriptS3Key: `scenario/${meetingId}/transcript.json`,
    finish: { attempts: 0, phase: "deliver" },
    ...overrides,
  });
}

/** Every notes chunk was posted exactly once, its distinct ids saved, and the finish cleared. */
export function expectEveryChunkOnce(world: World, row: MeetingHistory) {
  const chunks = renderMeetingDelivery(row).notes.map((chunk) =>
    String(chunk.embeds[0]?.title),
  );
  expect(chunks.length).toBeGreaterThan(1);
  const posted = finishChannelTitles(world);
  for (const title of chunks)
    expect(posted.filter((value) => value === title)).toHaveLength(1);
  expect(row.notesMessageIds).toHaveLength(chunks.length);
  expect(new Set(row.notesMessageIds).size).toBe(chunks.length);
  expect(row.recovery?.disposition).toBe("done");
  expect(row.finish).toBeUndefined();
}
