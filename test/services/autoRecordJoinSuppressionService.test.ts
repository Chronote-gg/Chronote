/** @jest-environment node */
import { AutoRecordJoinSuppressionService } from "../../src/services/autoRecordJoinSuppressionService";
import { getMockStore } from "../../src/repositories/mockStore";
import { getDeploymentControlRepository } from "../../src/db";
import type { SuppressionRecord } from "../../src/types/deploymentControl";

test("lateExplicitStopSuppressesNewRuntimeAutoJoin", async () => {
  getMockStore().deploymentControlRecords.clear();
  const oldOwner = new AutoRecordJoinSuppressionService();
  const newOwner = new AutoRecordJoinSuppressionService();
  await oldOwner.suppressUntilEmpty({
    guildId: "handoff-guild",
    channelId: "handoff-channel",
    meetingId: "meeting",
    nonBotMemberIds: ["person"],
    reason: "explicit_end",
  });
  expect(
    await newOwner.shouldSuppressAutoJoin("handoff-guild", "handoff-channel"),
  ).toBe(true);
});

describe("AutoRecordJoinSuppressionService", () => {
  beforeEach(() => {
    getMockStore().deploymentControlRecords.clear();
  });
  test("writeSuppression refuses a stale version", async () => {
    const record: SuppressionRecord = {
      pk: "SUPPRESS#synthetic-guild",
      sk: "CHANNEL#synthetic-channel",
      recordType: "suppression",
      protocolVersion: 1,
      guildId: "synthetic-guild",
      channelId: "synthetic-channel",
      meetingId: "synthetic-meeting",
      createdAt: 100,
      reason: "explicit_end",
      suppressed: true,
      version: 1,
    };
    const repository = getDeploymentControlRepository();
    expect(await repository.writeSuppression({ record })).toBe("applied");
    expect(await repository.writeSuppression({ record })).toBe("stale");
    expect(
      await repository.writeSuppression({
        record: { ...record, version: 2, suppressed: false },
        expectedVersion: 1,
      }),
    ).toBe("applied");
    expect(
      await repository.writeSuppression({
        record: { ...record, version: 2 },
        expectedVersion: 1,
      }),
    ).toBe("stale");
    expect(await repository.getRecord(record.pk, record.sk)).toMatchObject({
      version: 2,
      suppressed: false,
    });
  });
  test("a delayed clear on another runtime cannot erase a newer explicit stop", async () => {
    const old = new AutoRecordJoinSuppressionService();
    const next = new AutoRecordJoinSuppressionService();
    const input = {
      guildId: "g1",
      channelId: "c1",
      meetingId: "meeting",
      nonBotMemberIds: ["member"],
      reason: "explicit_end" as const,
    };
    await old.suppressUntilEmpty(input);
    const observed = await next.read("g1", "c1");
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    jest.spyOn(next, "read").mockImplementationOnce(async () => {
      await held;
      return observed;
    });
    const clearing = next.clearIfEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: () => [],
    });
    await old.suppressUntilEmpty(input);
    resume();
    expect(await clearing).toBe(false);
    expect(await next.shouldSuppressAutoJoin("g1", "c1")).toBe(true);
    expect(
      await next.clearIfEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: () => ["new-member"],
      }),
    ).toBe(false);
    expect(
      await next.clearIfEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: () => [],
      }),
    ).toBe(true);
    expect(await old.read("g1", "c1")).toMatchObject({
      version: 3,
      suppressed: false,
    });
  });
  test("suppresses auto-join until channel empties", async () => {
    const svc = new AutoRecordJoinSuppressionService();
    expect(
      await svc.suppressUntilEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: ["u1", "u2"],
        reason: "explicit_end",
        meetingId: "synthetic-meeting",
      }),
    ).toBe(true);
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    const result = await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(result.clearedSuppression).toBe(true);
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });

  test("does not suppress when no non-bot members are present", async () => {
    const svc = new AutoRecordJoinSuppressionService();
    expect(
      await svc.suppressUntilEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: [],
        reason: "explicit_end",
        meetingId: "synthetic-meeting",
      }),
    ).toBe(false);
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });

  test("ignores bot voice state changes", async () => {
    const svc = new AutoRecordJoinSuppressionService();
    await svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "forced_disconnect",
      meetingId: "synthetic-meeting",
    });

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "bot-1",
      isBot: true,
      oldChannelId: "c1",
      newChannelId: null,
    });

    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);
  });

  test("tracks member moves between channels for suppressed channels", async () => {
    const svc = new AutoRecordJoinSuppressionService();
    await svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "explicit_end",
      meetingId: "synthetic-meeting",
    });
    await svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c2",
      nonBotMemberIds: ["u2"],
      reason: "explicit_end",
      meetingId: "synthetic-meeting",
    });

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: "c2",
    });

    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
    expect(await svc.shouldSuppressAutoJoin("g1", "c2")).toBe(true);

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c2",
      newChannelId: null,
    });
    expect(await svc.shouldSuppressAutoJoin("g1", "c2")).toBe(true);

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c2",
      newChannelId: null,
    });
    expect(await svc.shouldSuppressAutoJoin("g1", "c2")).toBe(false);
  });

  test("tracks members who join after suppression begins", async () => {
    const svc = new AutoRecordJoinSuppressionService();
    await svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "explicit_end",
      meetingId: "synthetic-meeting",
    });

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: null,
      newChannelId: "c1",
    });

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    await svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(await svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });
});
