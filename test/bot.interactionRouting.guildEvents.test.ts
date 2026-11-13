/** @jest-environment node */
import {
  GUILD,
  GUILD_RECEIPT_CLAIM_MS,
  eventsOf,
  listener,
  mockWorld,
  settle,
  useRoutingWorkers,
  workerA,
  workerB,
  type MockWorker,
} from "./bot.interactionRouting.harness";
import { buildFirstMeetingInstallerMessage } from "../src/utils/firstMeetingGuide";

useRoutingWorkers();

describe("guild events", () => {
  const ownerSend = jest.fn(async () => undefined);
  const guild = () => ({
    id: GUILD,
    name: "Synthetic Server",
    joinedTimestamp: Date.now(),
    fetchOwner: async () => ({ user: { send: ownerSend } }),
  });
  beforeEach(() => ownerSend.mockClear());

  test("guild receipts are claimed without the interaction deadline", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    await listener(workerA, "guildCreate")(guild());
    await listener(workerA, "guildDelete")(guild());
    const bounds = timeout.mock.calls.map(([ms]) => ms);
    timeout.mockRestore();
    expect(bounds).toEqual([GUILD_RECEIPT_CLAIM_MS, GUILD_RECEIPT_CLAIM_MS]);
  });

  test("install side effects are claimed once across two workers", async () => {
    const joined = guild();
    await Promise.all([
      listener(workerA, "guildCreate")(joined),
      listener(workerB, "guildCreate")(joined),
    ]);
    expect(
      mockWorld.events.filter((event) =>
        event.startsWith("capture-server_installed:"),
      ),
    ).toHaveLength(1);
    expect(ownerSend).toHaveBeenCalledTimes(1);
    expect([...mockWorld.receipts]).toEqual([
      `guild-install:${GUILD}:${joined.joinedTimestamp}`,
    ]);
  });

  test("removal side effects are claimed once across two workers", async () => {
    const removed = guild();
    await Promise.all([
      listener(workerA, "guildDelete")(removed),
      listener(workerB, "guildDelete")(removed),
    ]);
    const once = (prefix: string) =>
      mockWorld.events.filter((event) => event.startsWith(prefix));
    expect(once("capture-server_removed:")).toHaveLength(1);
    expect(once("remove-installer:")).toHaveLength(1);
    expect([...mockWorld.receipts]).toEqual([
      `guild-remove:${GUILD}:${removed.joinedTimestamp}`,
    ]);
  });

  test("a non-eligible worker does nothing on install or removal", async () => {
    workerA.eligible = false;
    await listener(workerA, "guildCreate")(guild());
    await listener(workerA, "guildDelete")(guild());
    expect(eventsOf(workerA)).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  const installerWelcome = (worker: MockWorker) =>
    buildFirstMeetingInstallerMessage({
      guildId: GUILD,
      serverName: "Synthetic Server",
      siteUrl: worker.config!.frontend.siteUrl,
    });
  const installerUser = (send: () => Promise<unknown>) =>
    jest
      .spyOn(workerA.client!.users, "fetch")
      .mockResolvedValue({ send } as never);

  test("the install welcome goes once to the recorded installer, not the owner", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    const installerSend = jest.fn(async () => undefined);
    const fetch = installerUser(installerSend);
    const joined = guild();
    try {
      await listener(workerA, "guildCreate")(joined);
      expect(fetch).toHaveBeenCalledWith("synthetic-installer");
    } finally {
      fetch.mockRestore();
    }
    expect(mockWorld.installerLookups).toEqual([
      [GUILD, joined.joinedTimestamp],
    ]);
    expect(installerSend.mock.calls).toEqual([[installerWelcome(workerA)]]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test.each(["no recorded installer", "an unreachable installer"])(
    "the install welcome falls back to the owner for %s",
    async (situation) => {
      if (situation === "an unreachable installer")
        mockWorld.installer = { installerId: "synthetic-installer" };
      const fetch = jest
        .spyOn(workerA.client!.users, "fetch")
        .mockRejectedValue(new Error("synthetic unavailable user"));
      try {
        await listener(workerA, "guildCreate")(guild());
      } finally {
        fetch.mockRestore();
      }
      expect(ownerSend.mock.calls).toEqual([[installerWelcome(workerA)]]);
    },
  );

  test("a blocked install welcome is logged once without a retry or an owner message", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    const installerSend = jest.fn(async () => {
      throw new Error("synthetic blocked DM");
    });
    const fetch = installerUser(installerSend);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await listener(workerA, "guildCreate")(guild());
      expect(warn.mock.calls).toEqual([
        ["Could not DM installer/owner on join", expect.any(Error)],
      ]);
    } finally {
      warn.mockRestore();
      fetch.mockRestore();
    }
    expect(installerSend).toHaveBeenCalledTimes(1);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test("the install welcome is not sent while installer DMs are disabled", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    workerA.config!.server.onboardingEnabled = false;
    try {
      await listener(workerA, "guildCreate")(guild());
    } finally {
      workerA.config!.server.onboardingEnabled = true;
    }
    expect(mockWorld.installerLookups).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test("a guild returning from an outage (guildAvailable) is not an install", async () => {
    workerA.client!.emit("guildAvailable", guild() as never);
    await settle();
    expect(workerA.client!.listenerCount("guildAvailable")).toBe(0);
    expect(eventsOf(workerA)).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });
});
