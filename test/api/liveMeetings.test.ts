import { afterEach, expect, jest, test } from "@jest/globals";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerLiveMeetingRoutes } from "../../src/api/liveMeetings";
import { getMeeting } from "../../src/meetings";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../../src/services/guildAccessService";
import { ensureUserCanConnectChannel } from "../../src/services/discordPermissionsService";
import {
  buildLiveMeetingMeta,
  resolveLiveMeetingAttendees,
} from "../../src/services/liveMeetingService";
import { buildLiveMeetingTimelineEvents } from "../../src/services/meetingTimelineService";
import type { LiveMeetingMeta } from "../../src/types/liveMeeting";
import type { MeetingEvent } from "../../src/types/meetingTimeline";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  MEETING_STATUS,
} from "../../src/types/meetingLifecycle";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
  requestMeetingEndViaLease,
} from "../../src/services/activeMeetingLeaseService";

jest.mock("../../src/meetings", () => ({
  getMeeting: jest.fn(),
}));
jest.mock("../../src/services/guildAccessService", () => ({
  ensureUserInGuild: jest.fn(),
  ensureManageGuildWithUserToken: jest.fn(),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(),
}));
jest.mock("../../src/services/liveMeetingService", () => ({
  buildLiveMeetingMeta: jest.fn(),
  resolveLiveMeetingAttendees: jest.fn(),
}));
jest.mock("../../src/services/meetingTimelineService", () => ({
  buildLiveMeetingTimelineEvents: jest.fn(),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getActiveMeetingLeaseForGuild: jest.fn(),
  isLeaseActive: jest.fn(),
  requestMeetingEndViaLease: jest.fn(),
}));

const mockedGetMeeting = getMeeting as jest.MockedFunction<typeof getMeeting>;
const mockedEnsureUserInGuild = ensureUserInGuild as jest.MockedFunction<
  typeof ensureUserInGuild
>;
const mockedEnsureManageGuildWithUserToken =
  ensureManageGuildWithUserToken as jest.MockedFunction<
    typeof ensureManageGuildWithUserToken
  >;
const mockedEnsureUserCanConnectChannel =
  ensureUserCanConnectChannel as jest.MockedFunction<
    typeof ensureUserCanConnectChannel
  >;
const mockedBuildLiveMeetingMeta = buildLiveMeetingMeta as jest.MockedFunction<
  typeof buildLiveMeetingMeta
>;
const mockedResolveLiveMeetingAttendees =
  resolveLiveMeetingAttendees as jest.MockedFunction<
    typeof resolveLiveMeetingAttendees
  >;
const mockedBuildLiveMeetingTimelineEvents =
  buildLiveMeetingTimelineEvents as jest.MockedFunction<
    typeof buildLiveMeetingTimelineEvents
  >;
const mockedGetActiveMeetingLeaseForGuild =
  getActiveMeetingLeaseForGuild as jest.MockedFunction<
    typeof getActiveMeetingLeaseForGuild
  >;
const mockedIsLeaseActive = isLeaseActive as jest.MockedFunction<
  typeof isLeaseActive
>;
const mockedRequestMeetingEndViaLease =
  requestMeetingEndViaLease as jest.MockedFunction<
    typeof requestMeetingEndViaLease
  >;

const makeMeeting = (overrides?: Partial<MeetingData>): MeetingData =>
  ({
    guildId: "guild-1",
    meetingId: "meeting-1",
    voiceChannel: { id: "voice-1", name: "General" },
    startTime: new Date("2025-01-01T00:00:00.000Z"),
    attendance: new Set<string>(),
    finishing: false,
    finished: false,
    ...overrides,
  }) as MeetingData;

const makeMeta = (overrides?: Partial<LiveMeetingMeta>): LiveMeetingMeta => ({
  guildId: "guild-1",
  meetingId: "meeting-1",
  channelId: "voice-1",
  channelName: "General",
  startedAt: "2025-01-01T00:00:00.000Z",
  isAutoRecording: false,
  status: MEETING_STATUS.IN_PROGRESS,
  attendees: [],
  ...overrides,
});

const makeEvent = (overrides?: Partial<MeetingEvent>): MeetingEvent => ({
  id: "event-1",
  type: "voice",
  time: "0:01",
  text: "hello",
  ...overrides,
});

const createServer = (authenticated = true) => {
  const app = express();
  app.use((req, _res, next) => {
    (req as { isAuthenticated?: () => boolean }).isAuthenticated = () =>
      authenticated;
    if (authenticated) {
      req.user = { id: "user-1", accessToken: "token" };
    }
    req.session = {} as never;
    next();
  });
  registerLiveMeetingRoutes(app);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const requestJson = async (url: string) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });

const requestJsonPost = async (url: string) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: "POST" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });

const requestSseInit = async (url: string) =>
  new Promise<{ statusCode: number; buffer: string }>((resolve, reject) => {
    let resolved = false;
    const req = http.request(
      url,
      { method: "GET", headers: { Accept: "text/event-stream" } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        const finish = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve({ statusCode: res.statusCode ?? 0, buffer });
        };
        res.on("data", (chunk) => {
          buffer += chunk;
          if (
            buffer.includes("event: init") &&
            buffer.includes("data:") &&
            buffer.includes("\n\n")
          ) {
            finish();
            res.destroy();
            req.destroy();
          }
        });
        res.on("end", finish);
      },
    );
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      req.destroy();
      reject(new Error("Timed out waiting for init event"));
    }, 2000);
    req.on("error", (err) => {
      if (resolved) return;
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });

const requestSseUntil = async (url: string, contains: string) =>
  new Promise<{ statusCode: number; buffer: string }>((resolve, reject) => {
    let resolved = false;
    const req = http.request(
      url,
      { method: "GET", headers: { Accept: "text/event-stream" } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        const finish = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve({ statusCode: res.statusCode ?? 0, buffer });
        };
        res.on("data", (chunk) => {
          buffer += chunk;
          if (buffer.includes(contains)) {
            finish();
            res.destroy();
            req.destroy();
          }
        });
        res.on("end", finish);
      },
    );
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      req.destroy();
      reject(new Error("Timed out waiting for stream content"));
    }, 6000);
    req.on("error", (err) => {
      if (resolved) return;
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });

afterEach(() => {
  jest.resetAllMocks();
});

test("streams fallback init payload with leased channel name", async () => {
  mockedGetMeeting.mockReturnValue(undefined);
  mockedGetActiveMeetingLeaseForGuild.mockResolvedValue({
    guildId: "guild-1",
    meetingId: "meeting-1",
    ownerInstanceId: "instance-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "Engineering",
    textChannelId: "text-1",
    isAutoRecording: false,
    leaseExpiresAt: 1771102800,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    expiresAt: 1771102920,
  });
  mockedIsLeaseActive.mockReturnValue(true);
  mockedEnsureUserInGuild.mockResolvedValue(true);
  mockedEnsureUserCanConnectChannel.mockResolvedValue(true);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestSseInit(
      `${baseUrl}/api/live/guild-1/meeting-1/stream`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.buffer).toContain('"channelName":"Engineering"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("streams remote status event with endedAt", async () => {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  mockedGetMeeting.mockReturnValue(undefined);
  mockedGetActiveMeetingLeaseForGuild
    .mockResolvedValueOnce({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "Engineering",
      textChannelId: "text-1",
      isAutoRecording: false,
      status: MEETING_STATUS.IN_PROGRESS,
      leaseExpiresAt: nowEpochSeconds + 30,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: nowEpochSeconds + 150,
    })
    .mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "Engineering",
      textChannelId: "text-1",
      isAutoRecording: false,
      status: MEETING_STATUS.COMPLETE,
      endedAt: "2025-01-01T00:10:00.000Z",
      leaseExpiresAt: nowEpochSeconds - 5,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:10:00.000Z",
      expiresAt: nowEpochSeconds + 120,
    });
  mockedIsLeaseActive.mockImplementation(
    (lease) => lease.leaseExpiresAt >= Math.floor(Date.now() / 1000),
  );
  mockedEnsureUserInGuild.mockResolvedValue(true);
  mockedEnsureUserCanConnectChannel.mockResolvedValue(true);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestSseUntil(
      `${baseUrl}/api/live/guild-1/meeting-1/stream`,
      '"endedAt":"2025-01-01T00:10:00.000Z"',
    );
    expect(response.statusCode).toBe(200);
    expect(response.buffer).toContain("event: status");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("streams init payload for live meeting", async () => {
  const meeting = makeMeeting();
  mockedGetMeeting.mockReturnValue(meeting);
  mockedEnsureUserInGuild.mockResolvedValue(true);
  mockedEnsureUserCanConnectChannel.mockResolvedValue(true);
  mockedBuildLiveMeetingMeta.mockReturnValue(makeMeta());
  mockedBuildLiveMeetingTimelineEvents.mockReturnValue([makeEvent()]);
  mockedResolveLiveMeetingAttendees.mockReturnValue([]);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestSseInit(
      `${baseUrl}/api/live/guild-1/meeting-1/stream`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.buffer).toContain("event: init");
    expect(response.buffer).toContain('"meetingId":"meeting-1"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  expect(mockedEnsureUserInGuild).toHaveBeenCalledWith(
    "token",
    "guild-1",
    expect.objectContaining({ session: expect.any(Object) }),
  );
  expect(mockedEnsureUserCanConnectChannel).toHaveBeenCalledWith({
    guildId: "guild-1",
    channelId: "voice-1",
    userId: "user-1",
  });
});

test("returns 403 when user lacks manage guild for status", async () => {
  const meeting = makeMeeting();
  mockedGetMeeting.mockReturnValue(meeting);
  mockedEnsureManageGuildWithUserToken.mockResolvedValue(false);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJson(
      `${baseUrl}/api/live/guild-1/meeting-1/status`,
    );
    expect(response.statusCode).toBe(403);
    const payload = JSON.parse(response.body) as { error?: string };
    expect(payload.error).toBe("Manage Server permission required");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("returns status payload for live meeting when allowed", async () => {
  const meeting = makeMeeting({
    endReason: MEETING_END_REASONS.BUTTON as MeetingData["endReason"],
  });
  mockedGetMeeting.mockReturnValue(meeting);
  mockedEnsureManageGuildWithUserToken.mockResolvedValue(true);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJson(
      `${baseUrl}/api/live/guild-1/meeting-1/status`,
    );
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as { status?: string };
    expect(payload.status).toBe(MEETING_STATUS.IN_PROGRESS);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("returns remote lease snapshot status when meeting is not local", async () => {
  const leaseExpiresAt = Math.floor(Date.now() / 1000) + 600;
  mockedGetMeeting.mockReturnValue(undefined);
  mockedEnsureManageGuildWithUserToken.mockResolvedValue(true);
  mockedIsLeaseActive.mockReturnValue(true);
  mockedGetActiveMeetingLeaseForGuild.mockResolvedValue({
    guildId: "guild-1",
    meetingId: "meeting-1",
    ownerInstanceId: "instance-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "General",
    textChannelId: "text-1",
    isAutoRecording: false,
    status: MEETING_STATUS.PROCESSING,
    startReason: MEETING_START_REASONS.MANUAL_COMMAND,
    startTriggeredByUserId: "user-2",
    endReason: MEETING_END_REASONS.WEB_UI,
    endTriggeredByUserId: "user-3",
    endedAt: "2025-01-01T00:10:00.000Z",
    leaseExpiresAt,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:05:00.000Z",
    expiresAt: 1771102920,
  });

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJson(
      `${baseUrl}/api/live/guild-1/meeting-1/status`,
    );
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      status?: string;
      endTriggeredByUserId?: string;
      endedAt?: string;
    };
    expect(payload.status).toBe(MEETING_STATUS.PROCESSING);
    expect(payload.endTriggeredByUserId).toBe("user-3");
    expect(payload.endedAt).toBe("2025-01-01T00:10:00.000Z");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ends meeting via api endpoint", async () => {
  const onEndMeeting = jest
    .fn<(meeting: MeetingData) => Promise<void>>()
    .mockResolvedValue(undefined);
  const meeting = makeMeeting({ onEndMeeting });
  mockedGetMeeting.mockReturnValue(meeting);
  mockedEnsureManageGuildWithUserToken.mockResolvedValue(true);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJsonPost(
      `${baseUrl}/api/live/guild-1/meeting-1/end`,
    );
    expect(response.statusCode).toBe(200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  expect(onEndMeeting).toHaveBeenCalled();
  expect(meeting.endReason).toBe(MEETING_END_REASONS.WEB_UI);
  expect(meeting.endTriggeredByUserId).toBe("user-1");
});

test("queues remote meeting end request via active lease", async () => {
  mockedGetMeeting.mockReturnValue(undefined);
  mockedEnsureManageGuildWithUserToken.mockResolvedValue(true);
  mockedGetActiveMeetingLeaseForGuild.mockResolvedValue({
    guildId: "guild-1",
    meetingId: "meeting-1",
    ownerInstanceId: "instance-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "General",
    textChannelId: "text-1",
    isAutoRecording: false,
    leaseExpiresAt: 1771102800,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    expiresAt: 1771102920,
  });
  mockedIsLeaseActive.mockReturnValue(true);
  mockedRequestMeetingEndViaLease.mockResolvedValue(true);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJsonPost(
      `${baseUrl}/api/live/guild-1/meeting-1/end`,
    );
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as { status?: string };
    expect(payload.status).toBe("accepted");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  expect(mockedRequestMeetingEndViaLease).toHaveBeenCalledWith(
    "guild-1",
    "meeting-1",
    "user-1",
  );
});

test("returns 403 when user cannot connect to the voice channel", async () => {
  const meeting = makeMeeting();
  mockedGetMeeting.mockReturnValue(meeting);
  mockedEnsureUserInGuild.mockResolvedValue(true);
  mockedEnsureUserCanConnectChannel.mockResolvedValue(false);

  const { server, baseUrl } = createServer(true);
  try {
    const response = await requestJson(
      `${baseUrl}/api/live/guild-1/meeting-1/stream`,
    );
    expect(response.statusCode).toBe(403);
    const payload = JSON.parse(response.body) as { error?: string };
    expect(payload.error).toBe("Channel access required");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("returns 401 when unauthenticated", async () => {
  const { server, baseUrl } = createServer(false);
  try {
    const response = await requestJson(
      `${baseUrl}/api/live/guild-1/meeting-1/stream`,
    );
    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body) as { error?: string };
    expect(payload.error).toBe("Not authenticated");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
