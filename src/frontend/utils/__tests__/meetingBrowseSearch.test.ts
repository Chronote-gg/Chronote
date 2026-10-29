import {
  meetingBrowseSearchSchema,
  selectMeetingSource,
} from "../meetingBrowseSearch";

test("defaults to all accessible active meetings across all time", () => {
  expect(meetingBrowseSearchSchema.parse({})).toEqual({
    scope: "all",
    attended: false,
    range: "all",
    archive: "active",
  });
});
test("requires a guild source and removes irrelevant server IDs", () => {
  expect(meetingBrowseSearchSchema.safeParse({ scope: "guild" }).success).toBe(
    false,
  );
  expect(
    meetingBrowseSearchSchema.parse({ scope: "personal", serverId: "g" })
      .serverId,
  ).toBeUndefined();
});
test.each([{ meetingId: "m" }, { meetingServerId: "g" }])(
  "removes an incomplete drawer pair %j",
  (drawer) => {
    expect(
      meetingBrowseSearchSchema.parse({
        ...drawer,
        eventId: "e",
        fullScreen: true,
      }),
    ).toEqual({
      scope: "all",
      attended: false,
      range: "all",
      archive: "active",
    });
  },
);
test("preserves complete drawer and serialized state", () => {
  const input = {
    scope: "guild",
    serverId: "g",
    meetingServerId: "personal:u",
    meetingId: "voice#date",
    eventId: "line-2",
    fullScreen: "1",
    attended: "true",
    range: "7",
    archive: "all",
  };
  const parsed = meetingBrowseSearchSchema.parse(input);
  expect(parsed).toMatchObject({ ...input, fullScreen: true, attended: true });
  expect(
    meetingBrowseSearchSchema.parse(
      Object.fromEntries(new URLSearchParams(input)),
    ),
  ).toEqual(parsed);
});
test("source changes preserve dates and archive while clearing source filters and drawer", () => {
  const search = meetingBrowseSearchSchema.parse({
    scope: "guild",
    serverId: "g",
    q: "words",
    attended: true,
    channelId: "c",
    tags: "t",
    meetingServerId: "g",
    meetingId: "m",
    range: "custom",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    archive: "archived",
    cursor: "old",
  });
  expect(selectMeetingSource(search, { kind: "personal" })).toEqual({
    scope: "personal",
    attended: false,
    range: "custom",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    archive: "archived",
  });
});

test("accepts numeric day ranges parsed by the router", () => {
  expect(meetingBrowseSearchSchema.parse({ range: 7 }).range).toBe("7");
  expect(meetingBrowseSearchSchema.parse({ range: 30 }).range).toBe("30");
});
test("browser Back restores the previous serialized filters and drawer", async () => {
  const previous =
    "/portal/meetings?scope=guild&serverId=g&range=7&attended=true&meetingServerId=g&meetingId=voice%23date&eventId=e&fullScreen=true";
  window.history.replaceState({}, "", previous);
  window.history.pushState({}, "", "/portal/meetings?scope=personal&range=7");
  const navigated = new Promise<void>((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );
  window.history.back();
  await navigated;
  expect(window.location.pathname + window.location.search).toBe(previous);
  expect(
    meetingBrowseSearchSchema.parse(
      Object.fromEntries(new URLSearchParams(window.location.search)),
    ),
  ).toMatchObject({
    scope: "guild",
    serverId: "g",
    range: "7",
    attended: true,
    meetingServerId: "g",
    meetingId: "voice#date",
    eventId: "e",
    fullScreen: true,
  });
});
