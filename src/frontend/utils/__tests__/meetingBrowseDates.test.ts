import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { meetingDateRangeState } from "../meetingBrowseDates";

test("real Indianapolis time converts ISO instants to local input values and back without drift", () => {
  const source = pathToFileURL(
    resolve(__dirname, "../meetingBrowseDates.ts"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { formatLocalMeetingDate, parseLocalMeetingDate } from ${JSON.stringify(source)};
    const original = "2026-10-01T13:00:00.000Z";
    const edited = parseLocalMeetingDate("2026-10-01T09:30");
    console.log(JSON.stringify({
      offset: new Date(original).getTimezoneOffset(),
      shown: formatLocalMeetingDate(original),
      saved: parseLocalMeetingDate(formatLocalMeetingDate(original)),
      edited, shownAgain: formatLocalMeetingDate(edited),
      cleared: parseLocalMeetingDate("") ?? null
    }));
  `,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TZ: "America/Indiana/Indianapolis" },
    },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    offset: 240,
    shown: "2026-10-01T09:00",
    saved: "2026-10-01T13:00:00.000Z",
    edited: "2026-10-01T13:30:00.000Z",
    shownAgain: "2026-10-01T09:30",
    cleared: null,
  });
});
test.each([
  [{ range: "custom" }, "incomplete"],
  [{ range: "custom", startDate: "2026-10-01T13:00:00Z" }, "incomplete"],
  [
    { range: "custom", startDate: "invalid", endDate: "2026-10-01T13:00:00Z" },
    "invalid",
  ],
  [
    {
      range: "custom",
      startDate: "2026-10-01T14:00:00Z",
      endDate: "2026-10-01T13:00:00Z",
    },
    "invalid",
  ],
  [
    {
      range: "custom",
      startDate: "2026-10-01T13:00:00Z",
      endDate: "2026-10-01T14:00:00Z",
    },
    "ready",
  ],
])("classifies custom range readiness for %j", (search, expected) => {
  expect(meetingDateRangeState(search)).toBe(expected);
});
