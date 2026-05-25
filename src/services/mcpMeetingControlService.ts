import {
  getMeetingControlCommandForUser,
  queueMeetingControlCommand,
  resolveTargetOwnerForGuild,
  type MeetingControlCommandSnapshot,
} from "./meetingControlQueueService";
import {
  MEETING_CONTROL_COMMAND_TYPES,
  type LiveMeetingCommandInput,
  type StartMeetingCommandInput,
  type StopMeetingCommandInput,
} from "../types/meetingControl";

export class McpMeetingControlError extends Error {
  constructor(
    readonly code: "not_found" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const queueForGuildOwner = async (
  userId: string,
  commandType: (typeof MEETING_CONTROL_COMMAND_TYPES)[keyof typeof MEETING_CONTROL_COMMAND_TYPES],
  input:
    | StartMeetingCommandInput
    | StopMeetingCommandInput
    | LiveMeetingCommandInput,
) =>
  queueMeetingControlCommand({
    commandType,
    userId,
    input,
    targetOwnerInstanceId: await resolveTargetOwnerForGuild(input.serverId),
  });

export async function startMcpMeetingControl(input: {
  userId: string;
  request: StartMeetingCommandInput;
}) {
  return queueMeetingControlCommand({
    commandType: MEETING_CONTROL_COMMAND_TYPES.START_MEETING,
    userId: input.userId,
    input: input.request,
  });
}

export async function stopMcpMeetingControl(input: {
  userId: string;
  request: StopMeetingCommandInput;
}) {
  return queueForGuildOwner(
    input.userId,
    MEETING_CONTROL_COMMAND_TYPES.STOP_MEETING,
    input.request,
  );
}

export async function getMcpLiveMeetingStatus(input: {
  userId: string;
  request: LiveMeetingCommandInput;
}) {
  return queueForGuildOwner(
    input.userId,
    MEETING_CONTROL_COMMAND_TYPES.GET_LIVE_STATUS,
    input.request,
  );
}

export async function getMcpLiveMeetingTranscript(input: {
  userId: string;
  request: LiveMeetingCommandInput;
}) {
  return queueForGuildOwner(
    input.userId,
    MEETING_CONTROL_COMMAND_TYPES.GET_LIVE_TRANSCRIPT,
    input.request,
  );
}

export async function getMcpMeetingControlRequest(input: {
  userId: string;
  requestId: string;
}): Promise<MeetingControlCommandSnapshot> {
  const snapshot = await getMeetingControlCommandForUser(
    input.requestId,
    input.userId,
  );
  if (!snapshot) {
    throw new McpMeetingControlError("not_found", "Request not found.");
  }
  return snapshot;
}
