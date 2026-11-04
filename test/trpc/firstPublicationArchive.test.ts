/** @jest-environment node */
import { updateMeetingArchiveService } from "../../src/services/meetingHistoryService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
test("supported archive writer rejects an active publication and preserves state", async () => {
  resetMockStore();
  const store = getMockStore(),
    guild = store.userGuilds[0].id,
    row = store.meetingHistoryByGuild.get(guild)![0];
  row.publicationRepair = {
    kind: "running",
    runId: "run",
    previewDigest: "a".repeat(64),
    receiptKey: "receipt",
    snapshot: "b".repeat(64),
  };
  const before = JSON.stringify(row);
  await expect(
    updateMeetingArchiveService({
      guildId: guild,
      channelId_timestamp: row.channelId_timestamp,
      archived: true,
      archivedByUserId: "operator",
    }),
  ).rejects.toThrow("publication");
  expect(JSON.stringify(store.meetingHistoryByGuild.get(guild)![0])).toBe(
    before,
  );
});
