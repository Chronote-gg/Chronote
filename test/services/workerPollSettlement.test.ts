/** @jest-environment node */
// These suites exercise the pollers themselves; eligibility gating has its own suite.
jest.mock("../../src/services/workerRegistry", () => ({
  isEligible: () => true,
}));
import type { Client } from "discord.js";
import {
  startMeetingControlCommandWorker,
  stopMeetingControlCommandWorker,
} from "../../src/services/meetingControlWorkerService";
import {
  startPersonalMediaUploadWorker,
  stopPersonalMediaUploadWorker,
} from "../../src/services/personalMediaUploadWorkerService";
const mockControlList = jest.fn();
const mockControlClaim = jest.fn();
const mockPersonalList = jest.fn();
const mockPersonalClaim = jest.fn();
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => ({
    listClaimablePendingCommands: mockControlList,
    claimCommand: mockControlClaim,
  }),
}));
jest.mock("../../src/repositories/personalMediaUploadRepository", () => ({
  getPersonalMediaUploadRepository: () => ({
    listClaimable: mockPersonalList,
    claim: mockPersonalClaim,
  }),
}));
jest.mock("../../src/services/meetingControlBotService", () => ({
  executeMeetingControlCommand: jest.fn(),
}));
jest.mock("../../src/services/personalMediaUploadProcessingService", () => ({
  createPersonalMediaProcessingMeeting: jest.fn(),
  processPersonalMediaUpload: jest.fn(),
}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-worker",
}));
jest.mock("../../src/db", () => ({ personalMediaClaimForJob: jest.fn() }));
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test.each(["control", "personal"] as const)(
  "%s worker stop owns held list completion and prevents late claims or restart",
  async (domain) => {
    jest.useFakeTimers();
    const list = held<unknown[]>();
    const listMock = domain === "control" ? mockControlList : mockPersonalList;
    listMock.mockReturnValue(list.promise);
    const start = () =>
      domain === "control"
        ? startMeetingControlCommandWorker({} as Client)
        : startPersonalMediaUploadWorker();
    const stop =
      domain === "control"
        ? stopMeetingControlCommandWorker
        : stopPersonalMediaUploadWorker;
    try {
      start();
      expect(listMock).toHaveBeenCalledTimes(1);
      let settled = false;
      const stopping = Promise.resolve(stop()).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      list.resolve([
        {
          requestId: "synthetic-command",
          commandType: "start_meeting",
          input: {},
          uploadId: "synthetic-upload",
        },
      ]);
      await stopping;
      expect(mockPersonalClaim).not.toHaveBeenCalled();
      expect(mockControlClaim).not.toHaveBeenCalled();
      start();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(listMock).toHaveBeenCalledTimes(1);
    } finally {
      list.resolve([]);
      await stop();
      jest.useRealTimers();
    }
  },
);
