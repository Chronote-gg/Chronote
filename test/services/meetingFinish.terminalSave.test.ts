/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService");
jest.mock("../../src/services/notesService");
jest.mock("../../src/services/meetingSummaryService");
jest.mock("../../src/services/meetingNameService");

import type { MeetingHistory } from "../../src/types/db";
import {
  GENERATED_NOTE,
  GENERATED_SUMMARY,
  finishInput,
  loads,
  processingRow,
  setup,
  startMessage,
  useMeetingFinishHooks,
  type FinishWorld,
} from "./meetingFinish.fixture";

useMeetingFinishHooks();

const GENERATED_NAME = "Synthetic meeting";
const RENAME = "Synthetic rename";
const TERMINAL_ATTEMPTS = 3;
const OTHER = "synthetic-other-finisher";

/** A recording's row, whose canonical writer admits a portal edit while it processes. */
const recordingRow = (overrides: Partial<MeetingHistory> = {}) =>
  processingRow({
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId: "instance-synthetic",
      executionVersion: 1,
    },
    ...overrides,
  });

/** Loads the input, then a rename is acknowledged before the attempt saves. */
function loadThenRename(world: FinishWorld, meetingName = RENAME) {
  return async () => {
    const input = finishInput();
    await expect(world.correct(meetingName)).resolves.toMatchObject({
      kind: "saved",
    });
    return input;
  };
}

/** Runs `before` ahead of the next `count` terminal writes, as an edit racing them would. */
function beforeTerminalWrites(
  world: FinishWorld,
  count: number,
  before: () => Promise<unknown>,
) {
  const save = world.deps.repository.save;
  let remaining = count;
  world.deps.repository.save = async (claim, patch, ...rest) => {
    if (patch.status !== undefined && remaining > 0) {
      remaining -= 1;
      await before();
    }
    return save(claim, patch, ...rest);
  };
}

const posted = (world: FinishWorld) => JSON.stringify(startMessage(world));

/** The rename is kept beside this attempt's notes and summary, and it is the name delivery posts. */
function expectRenameSavedAndPosted(world: FinishWorld) {
  expect(world.current()).toMatchObject({
    status: "complete",
    meetingName: RENAME,
    notes: GENERATED_NOTE,
    summarySentence: GENERATED_SUMMARY,
  });
  expect(posted(world)).toContain(RENAME);
  expect(posted(world)).not.toContain(GENERATED_NAME);
}

test("a rename acknowledged after the input was loaded survives the terminal save and is what delivery posts", async () => {
  const world = setup(recordingRow());
  await world.finish(loadThenRename(world));
  expectRenameSavedAndPosted(world);
});

test("an edit landing between the refresh and the terminal write is refused and the retry keeps it", async () => {
  const world = setup(recordingRow());
  beforeTerminalWrites(world, 1, () => world.correct(RENAME));
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "complete",
    meetingName: RENAME,
    notes: GENERATED_NOTE,
  });
  expect(posted(world)).toContain(RENAME);
});

test("edits racing every terminal write fail the attempt into the normal backoff", async () => {
  const world = setup(recordingRow());
  let edits = 0;
  beforeTerminalWrites(world, TERMINAL_ATTEMPTS, () =>
    world.correct(`${RENAME} ${(edits += 1)}`),
  );
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "processing",
    meetingName: `${RENAME} ${TERMINAL_ATTEMPTS}`,
    finish: { attempts: 1, phase: "process" },
  });
  expect(world.current().finish?.nextAttemptAt).toBeDefined();
  expect(world.posts()).toHaveLength(0);
});

test("a claim lost at the last terminal write stops the attempt rather than reporting changing content", async () => {
  const world = setup(recordingRow());
  let edits = 0;
  beforeTerminalWrites(world, TERMINAL_ATTEMPTS, async () => {
    edits += 1;
    if (edits === TERMINAL_ATTEMPTS)
      world.current().finish = { ...world.current().finish!, owner: OTHER };
    else await world.correct(`${RENAME} ${edits}`);
  });
  await world.finish(loads(finishInput()));
  const warnings = jest.mocked(console.warn).mock.calls.map(([line]) => line);
  expect(warnings).toContain("Meeting finish attempt stopped");
  expect(warnings).not.toContain("Meeting finish attempt failed");
  expect(world.current()).toMatchObject({
    status: "processing",
    finish: { owner: OTHER, attempts: 0 },
  });
});

test("a revision that cannot say which fields changed keeps every canonical field the row holds", async () => {
  const world = setup(recordingRow({ meetingName: undefined }));
  await world.finish(async () => {
    // An older writer advanced the revision without recording its fields.
    Object.assign(world.current(), {
      contentRevision: 1,
      meetingName: RENAME,
    } satisfies Partial<MeetingHistory>);
    return finishInput();
  });
  expect(world.current()).toMatchObject({
    status: "complete",
    meetingName: RENAME,
    notes: GENERATED_NOTE,
    summarySentence: GENERATED_SUMMARY,
  });
});

test("a rename acknowledged while the meeting was still recording survives a normal-loader finish and is what delivery posts", async () => {
  const world = setup(recordingRow());
  await expect(world.correct(RENAME)).resolves.toMatchObject({
    kind: "saved",
  });
  await world.finish(loads(finishInput({ source: "normal" })));
  expectRenameSavedAndPosted(world);
});

test.each(["normal", "recovery"] as const)(
  "with no edit the terminal save writes the generated content (%s loader)",
  async (source) => {
    const world = setup(recordingRow());
    await world.finish(loads(finishInput({ source })));
    expect(world.current()).toMatchObject({
      status: "complete",
      meetingName: GENERATED_NAME,
      notes: GENERATED_NOTE,
      summarySentence: GENERATED_SUMMARY,
      summaryLabel: "Synthetic label",
      tags: ["alpha"],
    });
    expect(world.current().contentRevision).toBeUndefined();
  },
);
