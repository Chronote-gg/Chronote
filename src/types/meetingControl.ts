import type { MeetingStatus } from "./meetingLifecycle";

export const MEETING_CONTROL_COMMAND_TYPES = {
  START_MEETING: "start_meeting",
  STOP_MEETING: "stop_meeting",
  GET_LIVE_STATUS: "get_live_meeting_status",
  GET_LIVE_TRANSCRIPT: "get_live_meeting_transcript",
} as const;

export type MeetingControlCommandType =
  (typeof MEETING_CONTROL_COMMAND_TYPES)[keyof typeof MEETING_CONTROL_COMMAND_TYPES];

export type MeetingControlQueueStatus = "pending" | "completed" | "failed";

export type StartMeetingCommandInput = {
  serverId?: string;
  voiceChannelId?: string;
  textChannelId?: string;
  context?: string;
  tags?: string[];
};

export type StopMeetingCommandInput = {
  serverId?: string;
  meetingId?: string;
};

export type LiveMeetingCommandInput = {
  serverId?: string;
  meetingId?: string;
  afterEventId?: string;
  limit?: number;
};

export type MeetingControlCommandInput =
  | StartMeetingCommandInput
  | StopMeetingCommandInput
  | LiveMeetingCommandInput;

export type MeetingControlStartedResult = {
  status: "started";
  serverId: string;
  meetingId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId: string;
  startedAt: string;
  liveUrl?: string;
};

export type MeetingControlStoppedResult = {
  status: "stopping" | "ended";
  serverId: string;
  meetingId: string;
};

export type MeetingControlLiveStatusResult = {
  status: MeetingStatus;
  serverId: string;
  meetingId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId?: string;
  startedAt?: string;
  endedAt?: string;
  isAutoRecording?: boolean;
};

export type MeetingControlLiveTranscriptEvent = {
  id: string;
  type: string;
  time: string;
  speaker?: string;
  text: string;
};

export type MeetingControlLiveTranscriptResult = {
  serverId: string;
  meetingId: string;
  events: MeetingControlLiveTranscriptEvent[];
  hasMore: boolean;
  nextAfterEventId?: string;
};

export type MeetingControlCommandResult =
  | MeetingControlStartedResult
  | MeetingControlStoppedResult
  | MeetingControlLiveStatusResult
  | MeetingControlLiveTranscriptResult;

export type MeetingControlCommand = {
  requestId: string;
  queueStatus: MeetingControlQueueStatus;
  commandType: MeetingControlCommandType;
  userId: string;
  input: MeetingControlCommandInput;
  targetOwnerInstanceId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  claimedByInstanceId?: string;
  claimExpiresAt?: number;
  result?: MeetingControlCommandResult;
  error?: string;
};
