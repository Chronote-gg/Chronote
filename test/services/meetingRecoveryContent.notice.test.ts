/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import {
  INTERRUPTED_CAPTURE_NOTICE,
  SAVED_CONTENT_GAP_NOTICE,
  liveShapedNotesInput,
} from "../../src/services/meetingRecoveryContent";

const RECOVERY_NOTICE = `${INTERRUPTED_CAPTURE_NOTICE} Saved content can contain gaps.`;
const history = { meetingName: "Synthetic meeting" };

const notesInput = (transcription: "partial" | "ready") => ({
  recovered: true,
  captureNotice: RECOVERY_NOTICE,
  processing: { transcription },
});

test("a complete capture with an unverifiable piece keeps a gap notice that does not claim an interruption", () => {
  const shaped = liveShapedNotesInput(notesInput("partial"), history, false);
  expect(shaped.captureNotice).toBe(SAVED_CONTENT_GAP_NOTICE);
  expect(shaped.captureNotice).toContain("never invent missing discussion");
  expect(shaped.captureNotice).not.toContain(INTERRUPTED_CAPTURE_NOTICE);
});

test("a complete capture with every piece verified carries no notice", () => {
  const shaped = liveShapedNotesInput(notesInput("ready"), history, false);
  expect(shaped.captureNotice).toBeUndefined();
});

test("an interrupted capture keeps the recovery notice unchanged", () => {
  const shaped = liveShapedNotesInput(notesInput("partial"), history, true);
  expect(shaped.captureNotice).toBe(RECOVERY_NOTICE);
  expect(shaped.recovered).toBeUndefined();
  expect(shaped.meetingName).toBe(history.meetingName);
});
