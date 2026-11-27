/** @jest-environment node */
import { publishRetriedMeetings } from "../../scripts/publish-retried-meetings";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import type { MeetingHistory } from "../../src/types/db";
import { regenerationPayload } from "../repositories/meetingRegenerationContract";
import { history, pending } from "../types/meetingUpdateDelivery.fixture";

const operatorUserId = "111111111111111111";
const row = (
  index: number,
  patch: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  ...history(),
  channelId_timestamp: `999999999999999991#2026-10-28T0${index}:00:00.000Z`,
  lifecycleVersion: 2,
  status: "complete",
  textChannelId: "999999999999999994",
  processingRetry: regenerationPayload().job,
  updateDelivery: { ...pending(), policy: { kind: "unpublished" } },
  ...patch,
});

function world() {
  const rows = [
    row(1),
    row(2, { ownershipScope: "personal" }),
    row(3, { summaryMessageId: "999999999999999995" }),
    row(4, { finish: { attempts: 0, phase: "process" } }),
  ];
  const histories = new Map([[rows[0].guildId, structuredClone(rows)]]);
  const repository = createMockMeetingUpdateDeliveryRepository(histories);
  const stored = () => structuredClone(histories.get(rows[0].guildId)!);
  const run = (apply: boolean) =>
    publishRetriedMeetings({
      rows: stored(),
      apply,
      operatorUserId,
      repository,
    });
  return { rows, stored, run };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const printed = () =>
  jest.mocked(console.log).mock.calls.map(([line]) => String(line));

test("a dry run lists only the meeting awaiting publication and writes nothing", async () => {
  const w = world();
  expect(await w.run(false)).toBe(true);
  expect(w.stored()).toEqual(w.rows);
  expect(printed().filter((line) => line.startsWith("would_publish"))).toEqual([
    `would_publish ${w.rows[0].guildId} ${w.rows[0].channelId_timestamp}`,
  ]);
  expect(printed()[0]).toContain(operatorUserId);
});

test("apply hands back only that meeting, and a re-run changes nothing", async () => {
  const w = world();
  expect(await w.run(true)).toBe(true);
  const [armed, ...others] = w.stored();
  expect(armed).toMatchObject({
    finish: { attempts: 0, phase: "deliver" },
    updateDelivery: {
      policy: { kind: "held", reason: "initial_publication_unsettled" },
    },
  });
  expect(others).toEqual(w.rows.slice(1));
  const after = w.stored();
  expect(await w.run(true)).toBe(true);
  expect(w.stored()).toEqual(after);
  expect(printed().at(-1)).toBe(JSON.stringify({ results: {} }));
});

test("apply reports failure when the meeting changed after the scan", async () => {
  const w = world();
  const scanned = w.stored();
  await w.run(true);
  expect(
    await publishRetriedMeetings({
      rows: scanned,
      apply: true,
      operatorUserId,
      repository: createMockMeetingUpdateDeliveryRepository(
        new Map([[scanned[0].guildId, w.stored()]]),
      ),
    }),
  ).toBe(false);
});
