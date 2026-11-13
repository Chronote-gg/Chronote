/** @jest-environment node */
import {
  GUILD,
  MEETING,
  USER,
  eventsOf,
  liveMeeting,
  mockWorld,
  settle,
  useRoutingWorkers,
  workerA,
  workerB,
  type MockWorker,
} from "./bot.interactionRouting.harness";

useRoutingWorkers();

describe("voice state", () => {
  const member = { id: USER, user: { id: USER, bot: false } };
  const voiceGuild = {
    id: GUILD,
    channels: {
      cache: new Map([
        [
          "synthetic-voice",
          {
            id: "synthetic-voice",
            isVoiceBased: () => true,
            members: { filter: () => ({ map: () => [] }) },
          },
        ],
      ]),
    },
  };
  const state = (channelId: string | null) => ({
    guild: voiceGuild,
    channelId,
    channel: channelId ? { id: channelId, name: "Synthetic Voice" } : null,
    member,
  });
  const ready = (worker: MockWorker) => {
    worker.client!.user = { id: "synthetic-bot" } as never;
    if (worker.client!.listenerCount("voiceStateUpdate") === 0)
      worker.client!.emit("clientReady", worker.client as never);
  };
  const voiceUpdate = async (
    worker: MockWorker,
    from: string | null,
    to: string | null,
  ) => {
    ready(worker);
    worker.client!.emit("voiceStateUpdate", state(from), state(to));
    await settle();
  };

  test("auto-record is evaluated only by an eligible worker", async () => {
    workerA.eligible = false;
    await voiceUpdate(workerA, null, "synthetic-voice");
    await voiceUpdate(workerB, null, "synthetic-voice");
    expect(eventsOf(workerA)).not.toContain("autorecord-evaluated");
    expect(eventsOf(workerB)).toContain("autorecord-evaluated");
  });

  test("the recording worker handles its own emptied channel while draining", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting(1);
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(eventsOf(workerA)).toEqual(["end-with-notice"]);
  });

  test("the suppression clear is written only by an eligible worker that is not shutting down", async () => {
    workerA.eligible = false;
    workerB.shuttingDown = true;
    await voiceUpdate(workerA, "synthetic-voice", null);
    await voiceUpdate(workerB, "synthetic-voice", null);
    expect(eventsOf(workerA)).not.toContain("suppression-clear");
    expect(eventsOf(workerB)).not.toContain("suppression-clear");
  });

  test("an eligible worker that is not shutting down clears the suppression", async () => {
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(eventsOf(workerA)).toContain("suppression-clear");
  });

  test("the suppression clear counts only the channel's current non-bot members", async () => {
    const channel = voiceGuild.channels.cache.get("synthetic-voice")!;
    const original = channel.members;
    const present = [
      { id: "synthetic-person", user: { bot: false } },
      { id: "synthetic-other-bot", user: { bot: true } },
    ];
    channel.members = {
      filter: (keep: (member: (typeof present)[number]) => boolean) => ({
        map: (pick: (member: (typeof present)[number]) => string) =>
          present.filter(keep).map(pick),
      }),
    } as never;
    try {
      await voiceUpdate(workerA, "synthetic-voice", null);
    } finally {
      channel.members = original;
    }
    expect(mockWorld.clearedMembers).toEqual([["synthetic-person"]]);
  });

  test("a failed voice subscription on join is logged once without its details", async () => {
    workerA.live = liveMeeting(2);
    mockWorld.subscribeFailure = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
      expect(warn.mock.calls).toEqual([
        [
          "Voice state operation failed:",
          { stage: "voice-state-update", meetingId: MEETING },
        ],
      ]);
      expect(mockWorld.participants).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a successful voice subscription on join logs nothing", async () => {
    workerA.live = liveMeeting(2);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("an emptied channel ends the meeting with the channel-empty reason", async () => {
    workerA.live = liveMeeting(1);
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(workerA.live?.endReason).toBe("channel_empty");
    expect(workerA.live).not.toHaveProperty("endTriggeredByUserId");
    expect(eventsOf(workerA)).toContain("end-with-notice");
  });

  test("the bot leaving the meeting channel ends it with the bot-disconnect reason", async () => {
    workerA.live = liveMeeting(2);
    ready(workerA);
    const bot = {
      id: "synthetic-bot",
      user: { id: "synthetic-bot", bot: true },
    };
    workerA.client!.emit(
      "voiceStateUpdate",
      { ...state("synthetic-voice"), member: bot },
      { ...state(null), member: bot },
    );
    await settle();
    expect(workerA.live?.endReason).toBe("bot_disconnect");
    expect(workerA.live).not.toHaveProperty("endTriggeredByUserId");
    expect(eventsOf(workerA)).toContain("end-with-notice");
  });

  test("auto-record-all starts with its rule, trigger, reason and the server tags", async () => {
    mockWorld.autoRecordAll = true;
    await voiceUpdate(workerA, null, "synthetic-voice");
    expect(mockWorld.autostarts).toHaveLength(1);
    const [, , textChannel, options] = mockWorld.autostarts[0];
    expect(textChannel).toEqual({ id: "synthetic-notes" });
    expect(options).toMatchObject({
      tags: ["server-tag"],
      startReason: "auto_record_all",
      startTriggeredByUserId: USER,
      autoRecordRule: { mode: "all", channelId: "ALL" },
    });
  });

  test("an unavailable auto-record destination starts nothing", async () => {
    mockWorld.autoRecordAll = true;
    mockWorld.destinationMissing = true;
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
    } finally {
      error.mockRestore();
    }
    expect(mockWorld.autostarts).toEqual([]);
  });

  test("a channel with no auto-record setting starts nothing", async () => {
    await voiceUpdate(workerA, null, "synthetic-voice");
    expect(mockWorld.autostarts).toEqual([]);
  });
});
