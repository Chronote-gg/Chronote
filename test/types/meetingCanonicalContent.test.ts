/** @jest-environment node */
import { parseMeetingUpdateHistory } from "../../src/repositories/meetingUpdateDeliveryState";
import { canonicalFieldsSupersededAfter } from "../../src/types/meetingCanonicalContent";
import { history } from "../types/meetingUpdateDelivery.fixture";
test.each([{ notes: 0 }, { notes: 3 }, { arbitrary: 1 }])(
  "persisted canonical field tracking rejects malformed revisions: %j",
  (fieldRevisions) => {
    expect(() =>
      parseMeetingUpdateHistory({
        ...history(),
        contentRevision: 2,
        contentMutation: {
          id: "synthetic",
          fingerprint: "a".repeat(64),
          fieldRevisions,
        },
      }),
    ).toThrow();
  },
);
test("legacy mutation metadata remains readable but cannot prove an older in-flight generation", () => {
  const row = parseMeetingUpdateHistory({
    ...history(),
    contentRevision: 2,
    contentMutation: { id: "legacy", fingerprint: "legacy-fingerprint" },
  });
  expect(canonicalFieldsSupersededAfter(row, 0)).toBeUndefined();
  expect([...canonicalFieldsSupersededAfter(row, 2)!]).toEqual([]);
});
test("newer warning revision retains the prior independent canonical edits", () => {
  const row = parseMeetingUpdateHistory({
    ...history(),
    contentRevision: 3,
    contentMutation: {
      id: "warning",
      fingerprint: "a".repeat(64),
      fieldRevisions: { notes: 2, meetingName: 1 },
    },
  });
  expect([...canonicalFieldsSupersededAfter(row, 1)!]).toEqual([
    "notes",
    "notesVersion",
    "notesDelta",
    "notesHistory",
    "notesLastEditedBy",
    "notesLastEditedAt",
    "suggestionsHistory",
  ]);
});
