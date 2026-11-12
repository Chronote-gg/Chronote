/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/meetingClose", () => ({
  closeMeeting: jest.fn(async () => undefined),
}));
jest.mock(
  "../../src/embed",
  () =>
    jest.requireActual("../fixtures/meetingEndModuleMocks")
      .processingMessageEmbed,
);
jest.mock(
  "../../src/services/autoRecordJoinSuppressionService",
  () => jest.requireActual("../fixtures/meetingEndModuleMocks").joinSuppression,
);
jest.mock("../../src/meetings", () => ({
  getMeeting: jest.fn(),
}));
jest.mock("../../src/repositories/meetingHistoryTransitions", () => {
  const repository = {
    transitionMeetingHistory: jest.fn(async () => "applied"),
    getMeetingHistory: jest.fn(async () => undefined),
  };
  return { getMeetingHistoryTransitionRepository: () => repository };
});

import {
  Collection,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { handleTtsCommand } from "../../src/commands/tts";
import {
  handleEndMeetingButton,
  handleEndMeetingOther,
  runEndMeetingFlow,
} from "../../src/commands/endMeeting";
import { handleLeaveCommand } from "../../src/commands/leave";
import { endMeetingWithNotice } from "../../src/botMeetingEnd";
import { updateMeetingProcessingMessage } from "../../src/embed";
import { getMeeting } from "../../src/meetings";
import { autoRecordJoinSuppressionService } from "../../src/services/autoRecordJoinSuppressionService";
import { closeMeeting } from "../../src/services/meetingClose";
import { getMeetingHistoryTransitionRepository } from "../../src/repositories/meetingHistoryTransitions";
import type { MeetingData } from "../../src/types/meeting-data";
import type { DeliveryResult } from "../../src/types/meetingDelivery";

const client = {} as Client;
const CREATOR = "synthetic-creator";
const PRESSER = "synthetic-presser";
const CONTROL = "synthetic-control-message";

function meetingFor(overrides: Partial<MeetingData> = {}): MeetingData {
  return {
    guildId: "synthetic-guild",
    meetingId: "synthetic-meeting",
    sessionMode: "meeting",
    isAutoRecording: false,
    finishing: false,
    finished: false,
    startMessageId: CONTROL,
    creator: { id: CREATOR },
    voiceChannel: {
      id: "synthetic-voice",
      members: new Collection([
        ["synthetic-member", { id: "synthetic-member", user: { bot: false } }],
      ]),
    },
    textChannel: { send: jest.fn(async () => ({ id: "synthetic-notice" })) },
    ...overrides,
  } as unknown as MeetingData;
}

function button(userId = CREATOR, messageId = CONTROL) {
  return {
    guildId: "synthetic-guild",
    user: { id: userId },
    message: { id: messageId },
    deferred: false,
    replied: false,
    deferUpdate: jest.fn(async () => undefined),
    reply: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
  } as unknown as ButtonInteraction & {
    deferUpdate: jest.Mock;
    reply: jest.Mock;
  };
}

function leave(userId = CREATOR) {
  return {
    guildId: "synthetic-guild",
    guild: { members: { fetch: jest.fn(async () => null) } },
    user: { id: userId },
    options: { getBoolean: () => true },
    reply: jest.fn(async () => undefined),
    deferReply: jest.fn(async () => undefined),
    editReply: jest.fn(async () => undefined),
  };
}

function ttsStop(userId = CREATOR) {
  return {
    guildId: "synthetic-guild",
    guild: { members: { cache: new Collection(), fetch: async () => null } },
    user: { id: userId },
    options: { getSubcommand: () => "stop" },
    reply: jest.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

type EntryPoint = {
  name: string;
  meeting: () => MeetingData;
  run(meeting: MeetingData): Promise<unknown>;
  cause: { endReason: string; endTriggeredByUserId?: string };
};

const entryPoints: EntryPoint[] = [
  {
    name: "end button",
    meeting: () => meetingFor(),
    run: (meeting) => {
      jest.mocked(getMeeting).mockReturnValue(meeting);
      return handleEndMeetingButton(client, button(CREATOR));
    },
    cause: { endReason: "button", endTriggeredByUserId: CREATOR },
  },
  {
    name: "leave command",
    meeting: () => meetingFor(),
    run: (meeting) => {
      jest.mocked(getMeeting).mockReturnValue(meeting);
      return handleLeaveCommand(client, leave() as never);
    },
    cause: { endReason: "leave_command", endTriggeredByUserId: CREATOR },
  },
  // The two reasons below are chosen by the bot's voice-state handlers, tested
  // by bot.interactionRouting.voiceState "an emptied channel ends the meeting with the
  // channel-empty reason" and "the bot leaving the meeting channel ends it
  // with the bot-disconnect reason".
  {
    name: "emptied channel",
    meeting: () => meetingFor({ endReason: "channel_empty" }),
    run: (meeting) => endMeetingWithNotice(client, meeting, "Meeting ending."),
    cause: { endReason: "channel_empty" },
  },
  {
    name: "bot disconnected",
    meeting: () => meetingFor({ endReason: "bot_disconnect" }),
    run: (meeting) => endMeetingWithNotice(client, meeting, "Meeting ending."),
    cause: { endReason: "bot_disconnect" },
  },
  {
    name: "/tts stop of a voice-only session",
    meeting: () => meetingFor({ sessionMode: "tts_only" }),
    run: (meeting) => {
      jest.mocked(getMeeting).mockReturnValue(meeting);
      return handleTtsCommand(ttsStop());
    },
    cause: { endReason: "button", endTriggeredByUserId: CREATOR },
  },
  // The reason below is chosen inside buildMeetingSession's timer, tested by
  // meetings.test "ends at the captured cap before awaiting upgrade eligibility".
  {
    name: "duration limit",
    meeting: () => meetingFor({ endReason: "timeout" }),
    run: (meeting) => handleEndMeetingOther(client, meeting),
    cause: { endReason: "timeout" },
  },
  // Chosen by the start's end-request hook, tested by meetingStart.test
  // "a stop request during the start is applied once the meeting exists".
  {
    name: "remote stop request",
    meeting: () =>
      meetingFor({ endReason: "web_ui", endTriggeredByUserId: PRESSER }),
    run: (meeting) => handleEndMeetingOther(client, meeting),
    cause: { endReason: "web_ui", endTriggeredByUserId: PRESSER },
  },
  {
    name: "voice-only session",
    meeting: () =>
      meetingFor({ sessionMode: "tts_only", endReason: "channel_empty" }),
    run: (meeting) => runEndMeetingFlow({ meeting }),
    cause: { endReason: "channel_empty" },
  },
];

test.each(entryPoints)(
  "every end entry point calls closeMeeting exactly once with the expected cause: $name",
  async ({ meeting: make, run, cause }) => {
    const meeting = make();

    await run(meeting);

    expect(closeMeeting).toHaveBeenCalledTimes(1);
    expect(closeMeeting).toHaveBeenCalledWith(meeting, cause);
  },
);

test("a button press is answered, shows processing and ends with the presser recorded", async () => {
  const meeting = meetingFor();
  jest.mocked(getMeeting).mockReturnValue(meeting);
  const press = button(PRESSER);
  Object.assign(meeting, { creator: { id: PRESSER } });

  await handleEndMeetingButton(client, press);

  expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  expect(updateMeetingProcessingMessage).toHaveBeenCalledWith(meeting);
  expect(closeMeeting).toHaveBeenCalledWith(meeting, {
    endReason: "button",
    endTriggeredByUserId: PRESSER,
  });
});

test("the processing state is kept on the meeting, and a failed edit settles it with a warning", async () => {
  const meeting = meetingFor();
  jest
    .mocked(updateMeetingProcessingMessage)
    .mockRejectedValueOnce(new Error("synthetic edit failure"));

  await runEndMeetingFlow({ meeting });

  await expect(meeting.processingMessageShown).resolves.toBeUndefined();
  expect(console.warn).toHaveBeenCalledWith(
    "Meeting processing message was not shown",
    expect.objectContaining({ meetingId: "synthetic-meeting" }),
  );
});

const REPLACEMENT = "synthetic-replacement-message";
const HISTORY_KEY = {
  guildId: "synthetic-guild",
  channelId_timestamp: "synthetic-voice#synthetic-start",
};
const transition = () =>
  jest.mocked(getMeetingHistoryTransitionRepository().transitionMeetingHistory);

function reservedMeeting() {
  return meetingFor({
    reservation: {
      sessionMode: "meeting",
      guildId: "synthetic-guild",
      meetingId: "synthetic-meeting",
      ownerInstanceId: "synthetic-owner",
      executionVersion: 1,
      voiceOperationAttemptId: "synthetic-attempt",
      reservedAt: 0,
      historyKey: HISTORY_KEY,
    },
  });
}

/** The processing update had to post a new message, because the recording message was gone. */
function processingUpdateSends(outcome: "sent_fallback" | "edited_existing") {
  jest
    .mocked(updateMeetingProcessingMessage)
    .mockImplementationOnce(async (meeting) => {
      if (outcome === "sent_fallback") meeting.startMessageId = REPLACEMENT;
      const result: DeliveryResult = {
        outcome,
        intended: 1,
        sent: 1,
        errors: [],
      };
      return result;
    });
}

test("a processing update that posts a replacement saves its id to the row before it settles", async () => {
  const meeting = reservedMeeting();
  processingUpdateSends("sent_fallback");
  let saved: (outcome: "applied" | "stale") => void = () => undefined;
  // The row has already moved to processing by the time the replacement lands.
  transition()
    .mockResolvedValueOnce("stale")
    .mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
  let settled = false;

  await runEndMeetingFlow({ meeting });
  void meeting.processingMessageShown?.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));

  expect(settled).toBe(false);
  saved("applied");
  await meeting.processingMessageShown;
  expect(transition().mock.calls.map(([input]) => input)).toEqual(
    ["in_progress", "processing"].map((expectedStatus) =>
      expect.objectContaining({
        key: HISTORY_KEY,
        expectedMeetingId: "synthetic-meeting",
        expectedOwnerInstanceId: "synthetic-owner",
        expectedExecutionVersion: 1,
        expectedStatus,
        patch: { startMessageId: REPLACEMENT, updatedAt: expect.any(String) },
      }),
    ),
  );
});

test("a processing update that edits the recording message in place writes nothing", async () => {
  const meeting = reservedMeeting();
  processingUpdateSends("edited_existing");

  await runEndMeetingFlow({ meeting });
  await meeting.processingMessageShown;

  expect(transition()).not.toHaveBeenCalled();
});

test("a replacement id that cannot be saved is logged and the close goes on", async () => {
  const meeting = reservedMeeting();
  processingUpdateSends("sent_fallback");
  transition().mockRejectedValueOnce(new Error("synthetic outage"));

  await runEndMeetingFlow({ meeting });
  await expect(meeting.processingMessageShown).resolves.toBeUndefined();

  expect(closeMeeting).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(
    "Meeting start message id could not be saved",
    expect.objectContaining({ meetingId: "synthetic-meeting" }),
  );
});

test("a press on a stale control message changes nothing", async () => {
  const meeting = meetingFor();
  jest.mocked(getMeeting).mockReturnValue(meeting);
  const press = button(CREATOR, "synthetic-old-message");

  await handleEndMeetingButton(client, press);

  expect(press.reply).toHaveBeenCalledWith(
    "This meeting control is no longer active.",
  );
  expect(closeMeeting).not.toHaveBeenCalled();
});

test("a press by someone who may not end the meeting changes nothing", async () => {
  const meeting = meetingFor({
    guild: { members: { cache: new Collection() } },
  } as Partial<MeetingData>);
  jest.mocked(getMeeting).mockReturnValue(meeting);
  const press = button("synthetic-stranger");

  await handleEndMeetingButton(client, press);

  expect(press.reply).toHaveBeenCalledWith(
    "You do not have permission to end this meeting.",
  );
  expect(closeMeeting).not.toHaveBeenCalled();
});

test("explicit stop suppresses auto-record rejoin for that channel", async () => {
  const meeting = meetingFor({ isAutoRecording: true });
  jest.mocked(getMeeting).mockReturnValue(meeting);

  await handleEndMeetingButton(client, button(CREATOR));

  expect(
    autoRecordJoinSuppressionService.suppressUntilEmpty,
  ).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "synthetic-voice",
      nonBotMemberIds: ["synthetic-member"],
      reason: "explicit_end",
    }),
  );
});

test("an emptied channel ending an auto-recording sets no suppression", async () => {
  const meeting = meetingFor({
    isAutoRecording: true,
    endReason: "channel_empty",
  });

  await endMeetingWithNotice(client, meeting, "Meeting ending.");

  expect(
    autoRecordJoinSuppressionService.suppressUntilEmpty,
  ).not.toHaveBeenCalled();
});

test("a suppression write that fails still closes the meeting", async () => {
  const meeting = meetingFor({ isAutoRecording: true, endReason: "web_ui" });
  jest
    .mocked(autoRecordJoinSuppressionService.suppressUntilEmpty)
    .mockRejectedValueOnce(new Error("synthetic outage"));

  await handleEndMeetingOther(client, meeting);

  expect(closeMeeting).toHaveBeenCalledTimes(1);
});

test("a stop whose suppression the caller already saved does not save it again", async () => {
  const meeting = meetingFor({ isAutoRecording: true, endReason: "web_ui" });

  await runEndMeetingFlow({ meeting, suppressionPersisted: true });

  expect(
    autoRecordJoinSuppressionService.suppressUntilEmpty,
  ).not.toHaveBeenCalled();
  expect(updateMeetingProcessingMessage).toHaveBeenCalledWith(meeting);
  expect(closeMeeting).toHaveBeenCalledTimes(1);
});

test("a voice-only session shows no processing state", async () => {
  const meeting = meetingFor({ sessionMode: "tts_only" });

  await runEndMeetingFlow({ meeting });

  expect(updateMeetingProcessingMessage).not.toHaveBeenCalled();
});

test("a stop for a meeting already finishing shows nothing new and closes through the same promise", async () => {
  const meeting = meetingFor({ finishing: true });
  jest.mocked(getMeeting).mockReturnValue(meeting);
  const press = button(CREATOR);

  await handleEndMeetingButton(client, press);

  expect(press.followUp).toHaveBeenCalledWith(
    expect.objectContaining({ content: "Meeting is already finishing!" }),
  );
  expect(updateMeetingProcessingMessage).not.toHaveBeenCalled();
});
