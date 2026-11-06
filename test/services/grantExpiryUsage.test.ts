import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getEntitlementGrantRepository } from "../../src/repositories/entitlementGrantRepository";
import {
  clearGuildSubscriptionCache,
  getGuildLimits,
} from "../../src/services/subscriptionService";
import {
  getNextAvailableAt,
  getRollingUsageForGuild,
  getRollingWindowMs,
} from "../../src/services/meetingUsageService";
import type { EntitlementGrant, MeetingHistory } from "../../src/types/db";
import { getMockBillingSnapshot } from "../../src/services/billingService";

const guild = "grant-usage-test";
const expiry = Date.parse("2026-11-10T12:00:00.000Z");
const hour = 3_600_000;
const day = 24 * hour;
const iso = (ms: number) => new Date(ms).toISOString();
const grant = (
  overrides: Partial<EntitlementGrant> = {},
): EntitlementGrant => ({
  grantId: "temporary-pro",
  guildId: guild,
  tier: "pro",
  status: "active",
  source: "manual_comp",
  startsAt: iso(expiry - 10 * day),
  expiresAt: iso(expiry),
  createdAt: iso(expiry - 10 * day),
  createdBy: "synthetic-operator",
  ...overrides,
});
const meeting = (start: number, duration = 600): MeetingHistory => ({
  guildId: guild,
  channelId_timestamp: `voice#${iso(start)}`,
  meetingId: `synthetic-${start}`,
  channelId: "voice",
  timestamp: iso(start),
  participants: [],
  duration,
  transcribeMeeting: true,
  generateNotes: true,
});
function seed(...grants: EntitlementGrant[]) {
  for (const row of grants)
    getMockStore().entitlementGrants.set(row.grantId, row);
}
function recordings(...rows: MeetingHistory[]) {
  getMockStore().meetingHistoryByGuild.set(guild, rows);
}
const usage = (at = expiry) => getRollingUsageForGuild(guild, new Date(at));

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(expiry);
  resetMockStore();
  clearGuildSubscriptionCache();
  recordings(meeting(expiry - hour));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("ordinary rolling usage is unchanged without grants", async () => {
  await expect(usage()).resolves.toMatchObject({
    usedSeconds: 600,
    windowStartIso: iso(expiry - 7 * day),
  });
});
test("usage is not reset before a grant actually expires", async () => {
  seed(grant());
  await expect(usage(expiry - 1)).resolves.toMatchObject({ usedSeconds: 600 });
});
test("a natural expiry starts the fallback allowance at zero without editing records", async () => {
  const row = grant();
  seed(row);
  const before = JSON.stringify([
    row,
    getMockStore().meetingHistoryByGuild.get(guild),
  ]);
  await expect(usage()).resolves.toMatchObject({
    usedSeconds: 0,
    windowStartIso: iso(expiry),
    meetings: [],
  });
  expect(
    JSON.stringify([row, getMockStore().meetingHistoryByGuild.get(guild)]),
  ).toBe(before);
});
test("a meeting starting exactly at expiry counts in the fresh allowance", async () => {
  seed(grant());
  recordings(meeting(expiry - hour), meeting(expiry, 120));
  await expect(usage()).resolves.toMatchObject({
    usedSeconds: 120,
    windowStartIso: iso(expiry),
  });
});
test("a meeting started under the grant remains covered when it ends after expiry", async () => {
  seed(grant());
  recordings(meeting(expiry - hour, 7200));
  await expect(usage(expiry + 2 * hour)).resolves.toMatchObject({
    usedSeconds: 0,
  });
  expect(getMockStore().meetingHistoryByGuild.get(guild)?.[0].duration).toBe(
    7200,
  );
});
test("the first read days later uses actual expiry rather than read time", async () => {
  seed(grant());
  recordings(meeting(expiry - hour), meeting(expiry + hour, 120));
  await expect(usage(expiry + 3 * day)).resolves.toMatchObject({
    usedSeconds: 120,
    windowStartIso: iso(expiry),
  });
});
test("ordinary seven-day rolling expiry resumes after the new boundary ages out", async () => {
  seed(grant());
  recordings(meeting(expiry + hour, 120), meeting(expiry + 2 * day, 300));
  await expect(usage(expiry + 8 * day)).resolves.toMatchObject({
    usedSeconds: 300,
    windowStartIso: iso(expiry + day),
  });
});
test.each(["basic", "pro"] satisfies EntitlementGrant["tier"][])(
  "a %s grant ending beneath continuing Pro does not reset",
  async (tier) => {
    seed(
      grant({ tier }),
      grant({
        grantId: "continuing",
        startsAt: iso(expiry - day),
        expiresAt: iso(expiry + 2 * day),
      }),
    );
    await expect(usage(expiry + hour)).resolves.toMatchObject({
      usedSeconds: 600,
    });
  },
);
test("an equivalent renewal starting exactly at expiry preserves continuous coverage", async () => {
  seed(
    grant(),
    grant({
      grantId: "renewal",
      startsAt: iso(expiry),
      expiresAt: iso(expiry + 2 * day),
    }),
  );
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 600,
  });
});
test("the eventual end of renewed coverage creates the boundary once", async () => {
  seed(
    grant(),
    grant({
      grantId: "renewal",
      startsAt: iso(expiry),
      expiresAt: iso(expiry + 2 * day),
    }),
  );
  recordings(meeting(expiry + day));
  await expect(usage(expiry + 2 * day)).resolves.toMatchObject({
    usedSeconds: 0,
    windowStartIso: iso(expiry + 2 * day),
  });
});
test("a genuine Pro to Basic step down starts fresh even while Basic coverage remains", async () => {
  seed(
    grant(),
    grant({
      grantId: "basic",
      tier: "basic",
      expiresAt: iso(expiry + 2 * day),
    }),
  );
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 0,
    windowStartIso: iso(expiry),
  });
});
test("a renewal after a genuine gap does not erase the earlier expiry", async () => {
  seed(
    grant(),
    grant({
      grantId: "later",
      startsAt: iso(expiry + 1),
      expiresAt: iso(expiry + day),
    }),
  );
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 0,
    windowStartIso: iso(expiry),
  });
});
test("an extension made before expiry postpones the boundary", async () => {
  seed(grant({ expiresAt: iso(expiry + 2 * day) }));
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 600,
  });
});
test("early revocation does not manufacture a later natural-expiry reset", async () => {
  seed(grant({ status: "revoked", revokedAt: iso(expiry - day) }));
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 600,
  });
});
test("natural expiry survives a later revocation when dates prove it", async () => {
  seed(grant({ status: "revoked", revokedAt: iso(expiry + hour) }));
  await expect(usage(expiry + 2 * hour)).resolves.toMatchObject({
    usedSeconds: 0,
    windowStartIso: iso(expiry),
  });
});
test("permanent coverage does not expire or create a refill underneath it", async () => {
  seed(grant(), grant({ grantId: "permanent", expiresAt: undefined }));
  await expect(usage(expiry + hour)).resolves.toMatchObject({
    usedSeconds: 600,
  });
});
test("a future grant cannot conceal a real earlier expiry", async () => {
  seed(
    grant(),
    grant({
      grantId: "future",
      startsAt: iso(expiry + day),
      expiresAt: iso(expiry + 2 * day),
    }),
  );
  await expect(usage(expiry + hour)).resolves.toMatchObject({ usedSeconds: 0 });
});
test("another server's expired grant cannot reset this server", async () => {
  seed(grant({ guildId: "another-server" }));
  await expect(usage()).resolves.toMatchObject({ usedSeconds: 600 });
});
test("empty recordings stay unmetered and unknown transcription still counts after expiry", async () => {
  seed(grant());
  recordings(
    { ...meeting(expiry + hour, 500), processing: { transcription: "empty" } },
    meeting(expiry + 2 * hour, 120),
  );
  await expect(usage(expiry + 3 * hour)).resolves.toMatchObject({
    usedSeconds: 120,
  });
});
test("next-available calculation uses only the fresh allowance's meetings", async () => {
  seed(grant());
  recordings(
    meeting(expiry - hour, 7200),
    meeting(expiry + hour, 300),
    meeting(expiry + 2 * hour, 1200),
  );
  const result = await usage(expiry + day);
  expect(result.usedSeconds).toBe(1500);
  expect(
    getNextAvailableAt(
      result.meetings,
      Date.parse(result.windowStartIso),
      getRollingWindowMs(),
      1300,
    ),
  ).toBe(iso(expiry + hour + 7 * day));
});
test.each([
  { expiresAt: "invalid" },
  { startsAt: "invalid" },
  { expiresAt: iso(expiry - 11 * day) },
  { status: "revoked", revokedAt: undefined },
] satisfies Partial<EntitlementGrant>[])(
  "invalid grant history cannot fabricate zero usage: %j",
  async (invalid) => {
    seed(grant(invalid));
    await expect(usage()).rejects.toThrow(/grant usage history/i);
  },
);
test("a grant history read failure is not silently treated as no history", async () => {
  jest
    .spyOn(getEntitlementGrantRepository(), "list")
    .mockRejectedValueOnce(new Error("Synthetic history unavailable"));
  await expect(usage()).rejects.toThrow("Synthetic history unavailable");
});
test("the cached entitlement expires with the grant and agrees with the new allowance", async () => {
  seed(grant());
  getMockStore().subscriptions.set(guild, {
    guildId: guild,
    status: "active",
    tier: "basic",
    subscriptionType: "stripe",
    startDate: iso(expiry - 10 * day),
    mode: "test",
  });
  jest.setSystemTime(expiry - 1000);
  expect((await getGuildLimits(guild)).subscription.tier).toBe("pro");
  jest.setSystemTime(expiry);
  expect((await getGuildLimits(guild)).subscription.tier).toBe("basic");
  await expect(usage()).resolves.toMatchObject({ usedSeconds: 0 });
  await expect(getMockBillingSnapshot(guild)).resolves.toMatchObject({
    tier: "basic",
    usage: { usedMinutes: 0, limitMinutes: 1200, windowStartIso: iso(expiry) },
  });
});
test("editing the paid plan alone does not create an allowance reset", async () => {
  getMockStore().subscriptions.set(guild, {
    guildId: guild,
    status: "active",
    tier: "basic",
    subscriptionType: "stripe",
    startDate: iso(expiry - day),
    mode: "test",
  });
  await expect(getMockBillingSnapshot(guild)).resolves.toMatchObject({
    usage: { usedMinutes: 10 },
  });
  const paid = getMockStore().subscriptions.get(guild);
  if (!paid) throw new Error("Expected synthetic paid subscription");
  getMockStore().subscriptions.set(guild, { ...paid, tier: "pro" });
  clearGuildSubscriptionCache();
  await expect(getMockBillingSnapshot(guild)).resolves.toMatchObject({
    tier: "pro",
    usage: { usedMinutes: 10 },
  });
});
