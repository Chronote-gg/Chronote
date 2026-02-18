import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
  requestMeetingEndViaLease,
  releaseMeetingLeaseByIdentifiers,
  releaseMeetingLeaseForMeeting,
  startMeetingLeaseHeartbeat,
  tryAcquireMeetingLease,
} from "../../src/services/activeMeetingLeaseService";
import {
  getActiveMeetingLease,
  requestActiveMeetingEnd,
  releaseActiveMeetingLease,
  renewActiveMeetingLease,
  tryAcquireActiveMeetingLease,
} from "../../src/db";

jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  requestActiveMeetingEnd: jest.fn(),
  releaseActiveMeetingLease: jest.fn(),
  renewActiveMeetingLease: jest.fn(),
  tryAcquireActiveMeetingLease: jest.fn(),
}));

jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "instance-1",
}));

describe("activeMeetingLeaseService", () => {
  const mockedGetActiveMeetingLease = jest.mocked(getActiveMeetingLease);
  const mockedRequestActiveMeetingEnd = jest.mocked(requestActiveMeetingEnd);
  const mockedReleaseActiveMeetingLease = jest.mocked(
    releaseActiveMeetingLease,
  );
  const mockedRenewActiveMeetingLease = jest.mocked(renewActiveMeetingLease);
  const mockedTryAcquireActiveMeetingLease = jest.mocked(
    tryAcquireActiveMeetingLease,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-02-14T20:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("acquires lease with expected ownership payload", async () => {
    mockedTryAcquireActiveMeetingLease.mockResolvedValue(true);

    const acquired = await tryAcquireMeetingLease({
      guildId: "guild-1",
      meetingId: "meeting-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "General",
      textChannelId: "text-1",
      isAutoRecording: false,
    });

    expect(acquired).toBe(true);
    expect(mockedTryAcquireActiveMeetingLease).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        meetingId: "meeting-1",
        ownerInstanceId: "instance-1",
        voiceChannelId: "voice-1",
        voiceChannelName: "General",
        textChannelId: "text-1",
        isAutoRecording: false,
        leaseExpiresAt: 1771099230,
        createdAt: "2026-02-14T20:00:00.000Z",
        updatedAt: "2026-02-14T20:00:00.000Z",
        expiresAt: 1771099350,
      },
      1771099200,
    );
  });

  test("reports active lease status by epoch seconds", () => {
    expect(
      isLeaseActive({
        guildId: "guild-1",
        meetingId: "meeting-1",
        ownerInstanceId: "instance-1",
        voiceChannelId: "voice-1",
        textChannelId: "text-1",
        isAutoRecording: false,
        leaseExpiresAt: 1771102800,
        createdAt: "2026-02-14T20:00:00.000Z",
        updatedAt: "2026-02-14T20:00:00.000Z",
        expiresAt: 1771102950,
      }),
    ).toBe(true);
    expect(
      isLeaseActive(
        {
          guildId: "guild-1",
          meetingId: "meeting-1",
          ownerInstanceId: "instance-1",
          voiceChannelId: "voice-1",
          textChannelId: "text-1",
          isAutoRecording: false,
          leaseExpiresAt: 1771102799,
          createdAt: "2026-02-14T20:00:00.000Z",
          updatedAt: "2026-02-14T20:00:00.000Z",
          expiresAt: 1771102950,
        },
        1771102800,
      ),
    ).toBe(false);
  });

  test("renews lease on heartbeat and ends meeting if ownership is lost", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });
    mockedRenewActiveMeetingLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const onEndMeeting = jest.fn<() => Promise<void>>().mockResolvedValue();

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: false,
      onEndMeeting,
      endReason: undefined,
      textChannel: {
        send: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(20_000);

    expect(mockedRenewActiveMeetingLease).toHaveBeenCalled();
    expect(onEndMeeting).toHaveBeenCalledTimes(1);
  });

  test("releases lease by meeting object and clears heartbeat timer", async () => {
    mockedReleaseActiveMeetingLease.mockResolvedValue(true);
    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      leaseHeartbeatTimer: setInterval(() => undefined, 60_000),
    } as unknown as MeetingData;

    const released = await releaseMeetingLeaseForMeeting(meeting);

    expect(released).toBe(true);
    expect(meeting.leaseHeartbeatTimer).toBeUndefined();
    expect(mockedReleaseActiveMeetingLease).toHaveBeenCalledWith(
      "guild-1",
      "meeting-1",
      "instance-1",
    );
  });

  test("passes through simple read and delete helpers", async () => {
    mockedGetActiveMeetingLease.mockImplementation(async () => undefined);
    mockedReleaseActiveMeetingLease.mockResolvedValue(true);

    const lease = await getActiveMeetingLeaseForGuild("guild-1");
    const released = await releaseMeetingLeaseByIdentifiers(
      "guild-1",
      "meeting-1",
      "instance-1",
    );

    expect(lease).toBeUndefined();
    expect(released).toBe(true);
  });

  test("requests meeting end with user id and timestamp", async () => {
    mockedRequestActiveMeetingEnd.mockResolvedValue(true);

    const requested = await requestMeetingEndViaLease(
      "guild-1",
      "meeting-1",
      "user-1",
    );

    expect(requested).toBe(true);
    expect(mockedRequestActiveMeetingEnd).toHaveBeenCalledWith(
      "guild-1",
      "meeting-1",
      "user-1",
      expect.any(String),
    );
    const calledWithTimestamp =
      mockedRequestActiveMeetingEnd.mock.calls[0]?.[3];
    expect(Number.isNaN(Date.parse(calledWithTimestamp ?? ""))).toBe(false);
  });

  test("continues heartbeat renewal while meeting is finishing", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });
    mockedRenewActiveMeetingLease.mockResolvedValue(true);

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: true,
      finished: false,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(1);
  });

  test("prevents overlapping heartbeat renew attempts", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });

    let resolveFirstRenew: ((value: boolean) => void) | undefined;
    const firstRenew = new Promise<boolean>((resolve) => {
      resolveFirstRenew = resolve;
    });

    mockedRenewActiveMeetingLease
      .mockReturnValueOnce(firstRenew)
      .mockResolvedValue(true);

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: false,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(1);

    resolveFirstRenew?.(true);
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(2);
  });

  test("stops heartbeat immediately when meeting is already finished", async () => {
    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: true,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedGetActiveMeetingLease).not.toHaveBeenCalled();
    expect(mockedRenewActiveMeetingLease).not.toHaveBeenCalled();
    expect(meeting.leaseHeartbeatTimer).toBeUndefined();
  });
});
