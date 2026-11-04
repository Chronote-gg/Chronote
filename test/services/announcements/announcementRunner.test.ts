import { describe, expect, it } from "@jest/globals";
import { DiscordMessageHttpError } from "../../../src/services/discordMessageEditor";
import { DeliveryTableMissingError } from "../../../src/services/announcements/announcementDeliveryStore";
import {
  type AnnouncementPreview,
  buildAnnouncementPreview,
  previewCounts,
  previewDigest,
  type SendCounts,
  sendAnnouncementPreview,
  summaryLine,
  UnknownGuildError,
} from "../../../src/services/announcements/announcementRunner";
import { resolveAnnouncementTarget } from "../../../src/services/announcements/announcementTargets";
import {
  ANNOUNCEMENT_ID,
  announcement,
  BOT_USER_ID,
  createFakes,
  denyOnChannel,
  DM_CHANNEL_ID,
  EMBED_LINKS,
  fakeGuild,
  type FakeGuild,
  guildId,
  OWNER_ID,
  scope,
  systemChannelId,
  updatesChannelId,
  VIEW_CHANNEL,
} from "./announcementRunner.fixture";

const preview = (
  fakes: ReturnType<typeof createFakes>,
  input: { guildIds?: string[]; retryFailed?: boolean } = {},
) =>
  buildAnnouncementPreview(fakes.deps, {
    scope,
    announcement,
    warnings: [],
    retryFailed: input.retryFailed ?? false,
    ...(input.guildIds ? { guildIds: input.guildIds } : {}),
  });

const record = (
  guild: string,
  status: "pending" | "sent" | "failed",
  channelId = updatesChannelId(1),
) => ({
  announcementId: ANNOUNCEMENT_ID,
  guildId: guild,
  channelId,
  channelSource: "public_updates" as const,
  status,
  previewSha256: "0".repeat(64),
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
});

/** A server whose updates channel hides from the bot, so the owner gets a DM. */
const ownerDmGuild = (n: number) => {
  const guild = fakeGuild(n);
  denyOnChannel(guild, updatesChannelId(n), VIEW_CHANNEL | EMBED_LINKS);
  return guild;
};

const send = async (
  fakes: ReturnType<typeof createFakes>,
  built: AnnouncementPreview,
  signal?: AbortSignal,
) => {
  const lines: string[] = [];
  const counts = await sendAnnouncementPreview(fakes.deps, built, {
    signal,
    onEntry: (line) => lines.push(line),
  });
  return { counts, lines };
};

const skipped = (counts: SendCounts) =>
  Object.fromEntries(
    Object.entries(counts.skipped).filter(([, count]) => count > 0),
  );

describe("buildAnnouncementPreview", () => {
  it("resolves each installed server from a fresh snapshot and never writes", async () => {
    const guilds: FakeGuild[] = [
      fakeGuild(1),
      fakeGuild(2, { optedOut: true }),
      ownerDmGuild(3),
      fakeGuild(4, {
        publicUpdatesChannelId: null,
        systemChannelId: systemChannelId(4),
      }),
    ];
    const fakes = createFakes(guilds);
    const built = await preview(fakes);

    expect(built.entries.map((entry) => entry.guildId)).toEqual(
      guilds.map((guild) => guild.id),
    );
    const expected = guilds.map((guild) =>
      resolveAnnouncementTarget(
        {
          guildId: guild.id,
          guildName: guild.name,
          ownerId: guild.ownerId,
          roles: guild.roles,
          botRoleIds: ["100000000000000003"],
          publicUpdatesChannelId: guild.publicUpdatesChannelId,
          systemChannelId: guild.systemChannelId,
          notesChannelId: guild.notesChannelId,
          channels: guild.channels,
        },
        BOT_USER_ID,
        guild.optedOut,
      ),
    );
    expect(built.entries.map((entry) => entry.decision)).toEqual(expected);
    expect(built.entries[2].decision).toMatchObject({
      kind: "owner_dm",
      ownerId: OWNER_ID,
    });
    expect(built.botUserId).toBe(BOT_USER_ID);
    expect(built.embed.title).toBe(announcement.title);
    expect(built.createdAt).toBe("2026-11-04T12:00:00.000Z");
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
    expect(fakes.discord.openDmChannel).not.toHaveBeenCalled();
    expect(fakes.store.claimPending).not.toHaveBeenCalled();
    expect(fakes.store.markSent).not.toHaveBeenCalled();
    expect(fakes.store.markFailed).not.toHaveBeenCalled();
    expect(built.sha256).toBe(
      previewDigest(
        Object.fromEntries(
          Object.entries(built).filter(([key]) => key !== "sha256"),
        ) as Omit<AnnouncementPreview, "sha256">,
      ),
    );
  });

  it("skips servers with records and warns that the id is already used", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2), fakeGuild(3)]);
    fakes.records.set(guildId(1), record(guildId(1), "sent"));
    fakes.records.set(guildId(2), record(guildId(2), "pending"));
    fakes.records.set(guildId(3), {
      ...record(guildId(3), "failed"),
      reason: "discord_403",
    });

    const built = await preview(fakes);
    expect(built.entries.map((entry) => entry.decision)).toEqual([
      { kind: "skip", reason: "already_sent" },
      { kind: "skip", reason: "pending_unknown" },
      {
        kind: "skip",
        reason: "already_sent",
        detail: "earlier delivery failed (discord_403); use --retry-failed",
      },
    ]);
    expect(built.warnings).toEqual([
      `announcement id ${ANNOUNCEMENT_ID} already has 3 delivery records from an earlier preview (1 failed; --retry-failed retries those); those servers will not receive this version. Use a new id for new text.`,
    ]);

    const retried = await preview(fakes, { retryFailed: true });
    expect(retried.retryFailed).toBe(true);
    expect(retried.entries[2].decision).toMatchObject({
      kind: "target",
      channelId: updatesChannelId(3),
    });
  });

  it("treats a missing delivery table as no records and warns", async () => {
    const fakes = createFakes([fakeGuild(1)]);
    fakes.store.listForAnnouncement.mockRejectedValueOnce(
      new DeliveryTableMissingError("missing"),
    );
    const built = await preview(fakes);
    expect(built.warnings).toEqual([
      "delivery table not found; send will refuse until the Terraform change is applied",
    ]);
    expect(built.entries[0].decision.kind).toBe("target");
  });

  it("records a Discord read failure as discord_error and continues", async () => {
    const fakes = createFakes([
      fakeGuild(1, { readStatus: 403 }),
      fakeGuild(2, { readStatus: 404 }),
      fakeGuild(3),
    ]);
    const built = await preview(fakes);
    expect(built.entries.map((entry) => entry.decision)).toEqual([
      { kind: "skip", reason: "discord_error", detail: "status 403" },
      { kind: "skip", reason: "discord_error", detail: "status 404" },
      expect.objectContaining({ kind: "target" }),
    ]);
  });

  it("restricts to named servers and refuses ids the bot is not in", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2)]);
    const built = await preview(fakes, { guildIds: [guildId(2)] });
    expect(built.entries.map((entry) => entry.guildId)).toEqual([guildId(2)]);

    await expect(
      preview(fakes, { guildIds: [guildId(1), guildId(8), guildId(9)] }),
    ).rejects.toThrow(
      new UnknownGuildError(
        `Chronote is not installed in these servers: ${guildId(8)}, ${guildId(9)}`,
      ),
    );
  });
});

describe("previewDigest", () => {
  it("is stable under key order and changes with any entry", async () => {
    const { sha256: _sha256, ...unsigned } = await preview(
      createFakes([fakeGuild(1), fakeGuild(2)]),
    );
    void _sha256;
    const reordered = Object.fromEntries(
      Object.entries(unsigned).reverse(),
    ) as typeof unsigned;
    expect(previewDigest(reordered)).toBe(previewDigest(unsigned));

    const changed = { ...unsigned, entries: [...unsigned.entries] };
    changed.entries[1] = {
      guildId: guildId(2),
      decision: { kind: "skip", reason: "already_sent" },
    };
    expect(previewDigest(changed)).not.toBe(previewDigest(unsigned));
  });
});

describe("sendAnnouncementPreview", () => {
  it("claims, posts and marks each target in order, pacing between posts", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2), fakeGuild(3)]);
    const built = await preview(fakes);
    const order: string[] = [];
    fakes.store.claimPending.mockImplementation(async (claim) => {
      order.push(`claim ${claim.guildId}`);
      return "claimed";
    });
    fakes.discord.createMessage.mockImplementation(async (channelId) => {
      order.push(`post ${channelId}`);
      return { id: "900000000000000001" };
    });
    fakes.store.markSent.mockImplementation(async (_id, guild) => {
      order.push(`sent ${guild}`);
    });
    fakes.sleep.mockImplementation(async () => {
      order.push("sleep");
    });

    const { counts, lines } = await send(fakes, built);
    expect(order).toEqual([
      `claim ${guildId(1)}`,
      `post ${updatesChannelId(1)}`,
      `sent ${guildId(1)}`,
      "sleep",
      `claim ${guildId(2)}`,
      `post ${updatesChannelId(2)}`,
      `sent ${guildId(2)}`,
      "sleep",
      `claim ${guildId(3)}`,
      `post ${updatesChannelId(3)}`,
      `sent ${guildId(3)}`,
    ]);
    expect(fakes.sleep).toHaveBeenCalledWith(1000);
    expect(fakes.store.claimPending).toHaveBeenCalledWith(
      expect.objectContaining({
        announcementId: ANNOUNCEMENT_ID,
        guildId: guildId(1),
        channelId: updatesChannelId(1),
        channelSource: "public_updates",
        previewSha256: built.sha256,
      }),
      { replaceFailed: false },
    );
    expect(fakes.discord.createMessage).toHaveBeenCalledWith(
      updatesChannelId(1),
      built.embed,
      { content: undefined },
    );
    expect(counts).toMatchObject({ sent: 3, ownerDm: 0, failed: 0 });
    expect(lines).toHaveLength(3);
  });

  it("re-checks opt-out and the previewed channel before claiming", async () => {
    const guilds = [fakeGuild(1), fakeGuild(2), fakeGuild(3), fakeGuild(4)];
    const fakes = createFakes(guilds);
    const built = await preview(fakes);
    guilds[0].optedOut = true;
    denyOnChannel(guilds[1], updatesChannelId(2), EMBED_LINKS);
    guilds[2].channels = guilds[2].channels.filter(
      (channel) => channel.id !== updatesChannelId(3),
    );
    guilds.splice(3, 1);

    const { counts, lines } = await send(fakes, built);
    expect(skipped(counts)).toEqual({
      opted_out: 1,
      missing_permissions: 1,
      no_channel: 1,
      discord_error: 1,
    });
    expect(lines[1]).toContain("EmbedLinks");
    expect(lines[3]).toContain("status 404");
    expect(fakes.store.claimPending).not.toHaveBeenCalled();
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
  });

  it("never redirects to another channel when the previewed one changed", async () => {
    const guild = fakeGuild(1, { systemChannelId: systemChannelId(1) });
    const fakes = createFakes([guild]);
    const built = await preview(fakes);
    denyOnChannel(guild, updatesChannelId(1), VIEW_CHANNEL);
    await send(fakes, built);
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
    expect(fakes.discord.openDmChannel).not.toHaveBeenCalled();
  });

  it("skips already_sent when the claim finds an existing record", async () => {
    const fakes = createFakes([fakeGuild(1)]);
    const built = await preview(fakes);
    fakes.records.set(guildId(1), record(guildId(1), "sent"));
    const { counts } = await send(fakes, built);
    expect(skipped(counts)).toEqual({ already_sent: 1 });
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
  });

  it("marks a definite 4xx failed and leaves ambiguous outcomes pending", async () => {
    const fakes = createFakes([
      fakeGuild(1),
      fakeGuild(2),
      fakeGuild(3),
      fakeGuild(4),
    ]);
    const built = await preview(fakes);
    fakes.discord.createMessage
      .mockRejectedValueOnce(new DiscordMessageHttpError("create", 429, 1))
      .mockRejectedValueOnce(new DiscordMessageHttpError("create", 502))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

    const { counts } = await send(fakes, built);
    expect(counts).toMatchObject({ sent: 0, failed: 1, unknown: 3 });
    expect(fakes.store.markFailed).toHaveBeenCalledTimes(1);
    expect(fakes.records.get(guildId(1))).toMatchObject({
      status: "failed",
      reason: "discord_429",
    });
    for (const n of [2, 3, 4])
      expect(fakes.records.get(guildId(n))?.status).toBe("pending");
    expect(fakes.store.markSent).not.toHaveBeenCalled();
  });

  it("replaces failed records only when the preview retries failures", async () => {
    const fakes = createFakes([fakeGuild(1)]);
    fakes.records.set(guildId(1), record(guildId(1), "failed"));
    const built = await preview(fakes, { retryFailed: true });
    const { counts } = await send(fakes, built);
    expect(counts.sent).toBe(1);
    expect(fakes.store.claimPending).toHaveBeenCalledWith(expect.anything(), {
      replaceFailed: true,
    });
    expect(fakes.records.get(guildId(1))?.status).toBe("sent");
  });

  it("counts a post whose record update failed as sent and says so", async () => {
    const fakes = createFakes([fakeGuild(1)]);
    const built = await preview(fakes);
    fakes.store.markSent.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
    );
    const { counts, lines } = await send(fakes, built);
    expect(counts.sent).toBe(1);
    expect(lines[0]).toContain("record left pending");
  });

  it("stops at a store failure before posting and keeps the counts", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2)]);
    const built = await preview(fakes);
    fakes.store.claimPending.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
    );
    const { counts, lines } = await send(fakes, built);
    expect(counts).toMatchObject({ sent: 0, unknown: 1 });
    expect(lines[0]).toContain("ThrottlingException");
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
  });

  it("stops before the next server when the signal aborts", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2), fakeGuild(3)]);
    const built = await preview(fakes);
    const controller = new AbortController();
    fakes.store.markSent.mockImplementationOnce(async () => {
      controller.abort();
    });

    const { counts, lines } = await send(fakes, built, controller.signal);
    expect(counts).toMatchObject({ sent: 1, failed: 0, unknown: 0 });
    expect(fakes.store.claimPending).toHaveBeenCalledTimes(1);
    expect(fakes.discord.createMessage).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe("stopped by interrupt; 2 servers not attempted");
  });

  it("lets a post in flight at the interrupt finish and record sent", async () => {
    const fakes = createFakes([fakeGuild(1), fakeGuild(2)]);
    const built = await preview(fakes);
    const controller = new AbortController();
    fakes.discord.createMessage.mockImplementationOnce(async (channelId) => {
      controller.abort();
      return { id: `9${channelId.slice(1)}` };
    });

    const { counts, lines } = await send(fakes, built, controller.signal);
    expect(fakes.discord.createMessage).toHaveBeenCalledTimes(1);
    expect(fakes.discord.createMessage.mock.calls[0]?.[2]).toEqual({
      content: undefined,
    });
    expect(fakes.records.get(guildId(1))?.status).toBe("sent");
    expect(fakes.records.has(guildId(2))).toBe(false);
    expect(counts).toMatchObject({ sent: 1, unknown: 0 });
    expect(lines.at(-1)).toBe("stopped by interrupt; 1 servers not attempted");
  });
});

describe("sendAnnouncementPreview owner DMs", () => {
  const expectedContent =
    "Chronote could not post this notice in the community updates channel of Example\\_Server\\_1 because it is missing: View Channel, Embed Links. Grant these to Chronote in that channel to receive future notices there.";

  const dmFakes = async () => {
    const guild = ownerDmGuild(1);
    guild.name = "Example_Server_1";
    const fakes = createFakes([guild]);
    return { guild, fakes, built: await preview(fakes) };
  };

  it("opens the owner DM, claims it and posts the embed with the content line", async () => {
    const { fakes, built } = await dmFakes();
    const { counts } = await send(fakes, built);
    expect(fakes.discord.openDmChannel).toHaveBeenCalledWith(OWNER_ID);
    expect(fakes.store.claimPending).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: DM_CHANNEL_ID,
        channelSource: "owner_dm",
      }),
      { replaceFailed: false },
    );
    expect(fakes.discord.createMessage).toHaveBeenCalledWith(
      DM_CHANNEL_ID,
      built.embed,
      { content: expectedContent },
    );
    expect(counts).toMatchObject({ sent: 1, ownerDm: 1 });
  });

  it("sends no DM to an owner whose server opted out", async () => {
    const { guild, fakes, built } = await dmFakes();
    guild.optedOut = true;
    const { counts } = await send(fakes, built);
    expect(skipped(counts)).toEqual({ opted_out: 1 });
    expect(fakes.discord.openDmChannel).not.toHaveBeenCalled();
  });

  it("stays a DM even if the updates channel became postable", async () => {
    const { guild, fakes, built } = await dmFakes();
    guild.channels[0].permission_overwrites = [];
    await send(fakes, built);
    expect(fakes.discord.createMessage).toHaveBeenCalledTimes(1);
    expect(fakes.discord.createMessage.mock.calls[0][0]).toBe(DM_CHANNEL_ID);
  });

  it("skips owner_dms_closed when the DM channel cannot be opened", async () => {
    const { fakes, built } = await dmFakes();
    fakes.discord.openDmChannel.mockRejectedValueOnce(
      new DiscordMessageHttpError("DM channel open", 403),
    );
    const { counts } = await send(fakes, built);
    expect(skipped(counts)).toEqual({ owner_dms_closed: 1 });
    expect(counts.failed).toBe(0);
    expect(fakes.records.get(guildId(1))).toMatchObject({
      channelId: "dm_not_opened",
      channelSource: "owner_dm",
      status: "failed",
      reason: "owner_dms_closed",
    });
    expect(fakes.discord.createMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["a 403", new DiscordMessageHttpError("create", 403)],
    [
      "code 50007",
      new DiscordMessageHttpError("create", 400, undefined, 50007),
    ],
  ])(
    "skips owner_dms_closed when the DM post gets %s",
    async (_label, error) => {
      const { fakes, built } = await dmFakes();
      fakes.discord.createMessage.mockRejectedValueOnce(error);
      const { counts } = await send(fakes, built);
      expect(skipped(counts)).toEqual({ owner_dms_closed: 1 });
      expect(counts.failed).toBe(0);
      expect(fakes.records.get(guildId(1))).toMatchObject({
        status: "failed",
        reason: "owner_dms_closed",
      });
    },
  );

  it("does not DM a previous owner after ownership changed", async () => {
    const { guild, fakes, built } = await dmFakes();
    guild.ownerId = "100000000000000009";
    const { counts } = await send(fakes, built);
    expect(skipped(counts)).toEqual({ discord_error: 1 });
    expect(fakes.discord.openDmChannel).not.toHaveBeenCalled();
  });
});

describe("summaryLine", () => {
  it("prints counts in the fixed order", () => {
    const counts: SendCounts = {
      sent: 2,
      ownerDm: 1,
      failed: 0,
      unknown: 0,
      skipped: { opted_out: 1, missing_permissions: 1, already_sent: 1 },
    };
    expect(summaryLine(ANNOUNCEMENT_ID, "send", counts)).toBe(
      "announcement incident-2026-11-04: sent=2 owner_dm=1 skipped=3 (opted_out=1 no_channel=0 missing_permissions=1 owner_dms_closed=0 discord_error=0 already_sent=1 pending_unknown=0) failed=0 unknown=0",
    );
    expect(summaryLine(ANNOUNCEMENT_ID, "preview", counts)).toMatch(
      /^announcement incident-2026-11-04: would_send=2 owner_dm=1 skipped=3 /,
    );
  });

  it("counts a preview the way a send would report it", async () => {
    const fakes = createFakes([
      fakeGuild(1),
      ownerDmGuild(2),
      fakeGuild(3, { optedOut: true }),
    ]);
    const counts = previewCounts(await preview(fakes));
    expect(counts).toMatchObject({ sent: 2, ownerDm: 1, failed: 0 });
    expect(skipped(counts)).toEqual({ opted_out: 1 });
  });
});
