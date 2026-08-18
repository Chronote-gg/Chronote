import {
  resolveMeetingArtifactAccess,
  resolveServerMeetingArtifactAccess,
} from "../../src/services/meetingArtifactAccessService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "../../src/services/unifiedConfigService";
import type { ResolvedConfigSnapshot } from "../../src/config/types";

jest.mock("../../src/services/unifiedConfigService", () => ({
  getSnapshotBoolean: jest.fn(),
  resolveConfigSnapshot: jest.fn(),
}));

const mockedResolveConfigSnapshot = jest.mocked(resolveConfigSnapshot);
const mockedGetSnapshotBoolean = jest.mocked(getSnapshotBoolean);
const emptySnapshot: ResolvedConfigSnapshot = {
  values: {},
  experimentalEnabled: false,
  missingRequired: [],
};

describe("meetingArtifactAccessService", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedResolveConfigSnapshot.mockResolvedValue(emptySnapshot);
    mockedGetSnapshotBoolean
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
  });

  test("resolves independent server artifact settings", async () => {
    await expect(
      resolveServerMeetingArtifactAccess("guild-1"),
    ).resolves.toEqual({
      transcriptAccessEnabled: false,
      audioAccessEnabled: true,
    });
    expect(mockedResolveConfigSnapshot).toHaveBeenCalledWith({
      guildId: "guild-1",
    });
  });

  test("keeps personal meeting artifacts controlled by their owner", async () => {
    await expect(
      resolveMeetingArtifactAccess({
        guildId: "personal:user-1",
        ownershipScope: "personal",
        ownerUserId: "user-1",
      }),
    ).resolves.toEqual({
      transcriptAccessEnabled: true,
      audioAccessEnabled: true,
    });
    expect(mockedResolveConfigSnapshot).not.toHaveBeenCalled();
  });

  test("fails closed when server settings cannot be resolved", async () => {
    mockedResolveConfigSnapshot.mockRejectedValueOnce(new Error("offline"));

    await expect(
      resolveServerMeetingArtifactAccess("guild-1"),
    ).resolves.toEqual({
      transcriptAccessEnabled: false,
      audioAccessEnabled: false,
    });
  });
});
