/** @jest-environment node */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { buildFirstMeetingInstallerMessage } from "../../src/utils/firstMeetingGuide";
import { setTimeout as delay } from "node:timers/promises";
import { fetchGuildInstallerForMembership } from "../../src/services/guildInstallerService";
import { waitForGuildInstaller } from "../../src/services/guildInstallerOnboardingService";

jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../src/services/guildInstallerService", () => ({
  fetchGuildInstallerForMembership: jest.fn(),
}));
const lookup = jest.mocked(fetchGuildInstallerForMembership);
beforeEach(() => jest.clearAllMocks());
test("waits for callback persistence before selecting the installing account", async () => {
  const installer = {
    guildId: "guild",
    installerId: "installer",
    installedAt: "2026-09-05T23:00:00.000Z",
  };
  lookup
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(installer);
  await expect(waitForGuildInstaller("guild", 1000)).resolves.toEqual(
    installer,
  );
  expect(delay).toHaveBeenCalledTimes(2);
  expect(lookup).toHaveBeenLastCalledWith("guild", 1000);
});
test("bounds waiting for direct installs with no callback", async () => {
  lookup.mockResolvedValue(undefined);
  await expect(waitForGuildInstaller("guild", 1000)).resolves.toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(10);
  expect(delay).toHaveBeenCalledTimes(9);
});
test("uses an already-persisted current installer without waiting", async () => {
  const installer = {
    guildId: "guild",
    installerId: "installer",
    installedAt: "2026-09-05T23:00:00.000Z",
  };
  lookup.mockResolvedValue(installer);
  await expect(waitForGuildInstaller("guild", 1000)).resolves.toEqual(
    installer,
  );
  expect(delay).not.toHaveBeenCalled();
});

async function installerDm(
  options: {
    installer?: boolean;
    fetchFails?: boolean;
    dmFails?: boolean;
    enabled?: boolean;
  } = {},
) {
  const installerSend = jest.fn().mockResolvedValue(undefined);
  const ownerSend = jest.fn().mockResolvedValue(undefined);
  if (options.dmFails) installerSend.mockRejectedValue(new Error("DM blocked"));
  const fetch = options.fetchFails
    ? jest.fn().mockRejectedValue(new Error("User unavailable"))
    : jest.fn().mockResolvedValue({ send: installerSend });
  const fetchOwner = jest.fn().mockResolvedValue({ user: { send: ownerSend } });
  const guild = {
    id: "guild",
    name: "The Workshop",
    joinedTimestamp: 1000,
    fetchOwner,
  };
  const client = Object.assign(new EventEmitter(), {
    login: jest.fn(),
    users: { fetch },
    guilds: { cache: new Map() },
  });
  lookup.mockResolvedValue(
    options.installer === false
      ? undefined
      : {
          guildId: "guild",
          installerId: "installer",
          installedAt: "2026-09-05T23:00:00.000Z",
        },
  );
  const warn = jest.fn();
  const captureEvent = jest.fn();
  const assertServing = jest.fn();
  const source = ts.createSourceFile(
    "bot.ts",
    readFileSync(path.join(__dirname, "../../src/bot.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "setupBot",
  );
  if (!declaration) throw new Error("Missing production setupBot");
  const context = vm.createContext({
    client,
    TOKEN: "fake",
    CLIENT_ID: "bot",
    Events: { ClientReady: "ready" },
    config: {
      server: { onboardingEnabled: options.enabled ?? true },
      frontend: { siteUrl: "https://chronote.test" },
    },
    isRuntimeWarm: () => false,
    runServingBotWork: (run: (assert: () => Promise<void>) => Promise<void>) =>
      run(assertServing),
    invalidateBotGuildCache: jest.fn(),
    invalidateGuildCache: jest.fn(),
    isFreshGuildJoin: () => false,
    waitForGuildInstaller,
    buildFirstMeetingInstallerMessage,
    captureEvent,
    console: { warn, log: jest.fn() },
  });
  await vm.runInContext(
    ts.transpileModule(
      declaration.getText(source).replace(/^export /, "") + "\nsetupBot();",
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    context,
  );
  await client.listeners("guildCreate")[0](guild);
  return {
    installerSend,
    ownerSend,
    fetchOwner,
    fetch,
    warn,
    captureEvent,
    assertServing,
  };
}

test("existing installer DM sends the approved payload once to the discovered installer", async () => {
  const result = await installerDm();
  expect(result.fetch).toHaveBeenCalledWith("installer");
  expect(result.installerSend).toHaveBeenCalledTimes(1);
  expect(result.installerSend).toHaveBeenCalledWith(
    buildFirstMeetingInstallerMessage({
      guildId: "guild",
      serverName: "The Workshop",
      siteUrl: "https://chronote.test",
    }),
  );
  expect(result.assertServing).toHaveBeenCalledTimes(1);
  expect(result.fetchOwner).not.toHaveBeenCalled();
  expect(result.captureEvent).not.toHaveBeenCalled();
});

test.each([{ installer: false }, { fetchFails: true }])(
  "existing installer DM retains owner fallback: %s",
  async (options) => {
    const result = await installerDm(options);
    expect(result.fetchOwner).toHaveBeenCalledTimes(1);
    expect(result.ownerSend).toHaveBeenCalledTimes(1);
    expect(result.installerSend).not.toHaveBeenCalled();
    expect(result.ownerSend.mock.calls[0][0].content).toContain(
      "Thanks for adding Chronote to **The Workshop**.",
    );
    expect(result.captureEvent).not.toHaveBeenCalled();
  },
);

test("existing installer DM catches blocked DMs without a retry or extra message", async () => {
  const result = await installerDm({ dmFails: true });
  expect(result.warn).toHaveBeenCalledWith(
    "Could not DM installer/owner on join",
    expect.any(Error),
  );
  expect(result.installerSend).toHaveBeenCalledTimes(1);
  expect(result.fetchOwner).not.toHaveBeenCalled();
  expect(result.ownerSend).not.toHaveBeenCalled();
});

test("existing installer DM remains feature gated", async () => {
  const result = await installerDm({ enabled: false });
  expect(lookup).not.toHaveBeenCalled();
  expect(result.fetch).not.toHaveBeenCalled();
  expect(result.fetchOwner).not.toHaveBeenCalled();
  expect(result.installerSend).not.toHaveBeenCalled();
  expect(result.ownerSend).not.toHaveBeenCalled();
});
