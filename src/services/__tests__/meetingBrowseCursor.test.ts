/** @jest-environment node */
import {
  encodeMeetingBrowseCursor,
  decodeMeetingBrowseCursor,
  meetingBrowseFingerprint,
  type MeetingBrowseCursorPayload,
} from "../meetingBrowseCursor";
import {
  getMeetingBrowseCursorState,
  putMeetingBrowseCursorState,
} from "../../db";
import type { MeetingBrowseFilters } from "../../types/meetingBrowse";

jest.mock("../../db", () => ({
  getMeetingBrowseCursorState: jest.fn(),
  putMeetingBrowseCursorState: jest.fn(),
}));
jest.mock("../configService", () => ({
  config: { server: { sessionSecret: "test-cursor-secret" } },
}));
const filters: MeetingBrowseFilters = {
  scope: { kind: "all" },
  attendedOnly: false,
};
const states = new Map<string, unknown>();
const payload = (): MeetingBrowseCursorPayload => ({
  version: 2,
  actorId: "actor",
  filterFingerprint: meetingBrowseFingerprint(filters),
  requestFingerprint: "request",
  startTimestamp: "1970-01-01T00:00:00.000Z",
  endTimestamp: "2026-10-29T00:00:00.000Z",
  expiresAt: Date.now() + 3600000,
  sources: [{ kind: "user", id: "actor", exhausted: false }],
  pending: [],
});
beforeEach(() => {
  states.clear();
  jest.clearAllMocks();
  jest
    .mocked(putMeetingBrowseCursorState)
    .mockImplementation(async (id, state) => {
      states.set(id, structuredClone(state));
    });
  jest
    .mocked(getMeetingBrowseCursorState)
    .mockImplementation(async (id) => structuredClone(states.get(id)));
});
test("stores immutable snapshots behind a compact reference, without source keys", async () => {
  const state = payload();
  state.sources = Array.from({ length: 100 }, (_, i) => ({
    kind: "guild",
    id: `private-guild-${i}`,
    exhausted: false,
    checkpoint: { guildId: { S: `private-guild-${i}` } },
  }));
  const token = await encodeMeetingBrowseCursor(state);
  expect(token.length).toBeLessThan(600);
  expect(
    Buffer.from(token.split(".")[0], "base64url").toString(),
  ).not.toContain("private-guild");
  state.sources[0].exhausted = true;
  const decoded = await decodeMeetingBrowseCursor(token, "actor", filters);
  expect(decoded.sources[0].exhausted).toBe(false);
  decoded.sources[0].exhausted = true;
  expect(
    (await decodeMeetingBrowseCursor(token, "actor", filters)).sources[0]
      .exhausted,
  ).toBe(false);
});
test("rejects actor, filter, tampering, missing-state and expired-state cursors", async () => {
  const token = await encodeMeetingBrowseCursor(payload());
  await expect(
    decodeMeetingBrowseCursor(token, "other", filters),
  ).rejects.toThrow(/cursor/i);
  await expect(
    decodeMeetingBrowseCursor(token, "actor", {
      ...filters,
      attendedOnly: true,
    }),
  ).rejects.toThrow(/cursor/i);
  await expect(
    decodeMeetingBrowseCursor(token + "x", "actor", filters),
  ).rejects.toThrow(/cursor/i);
  await expect(
    decodeMeetingBrowseCursor(token + ".extra", "actor", filters),
  ).rejects.toThrow(/cursor/i);
  await expect(
    decodeMeetingBrowseCursor(token, "actor", filters, Date.now() + 3600001),
  ).rejects.toThrow(/cursor/i);
  states.clear();
  await expect(
    decodeMeetingBrowseCursor(token, "actor", filters),
  ).rejects.toThrow(/cursor/i);
});
test("checks stored actor and filter binding, not only the signature", async () => {
  const token = await encodeMeetingBrowseCursor(payload());
  const id = [...states.keys()][0];
  states.set(id, { ...payload(), actorId: "other" });
  await expect(
    decodeMeetingBrowseCursor(token, "actor", filters),
  ).rejects.toThrow(/cursor/i);
  states.set(id, { ...payload(), filterFingerprint: "other" });
  await expect(
    decodeMeetingBrowseCursor(token, "actor", filters),
  ).rejects.toThrow(/cursor/i);
  states.set(id, { ...payload(), expiresAt: Date.now() - 1 });
  await expect(
    decodeMeetingBrowseCursor(token, "actor", filters),
  ).rejects.toThrow(/cursor/i);
});
