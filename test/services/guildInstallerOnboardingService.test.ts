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
