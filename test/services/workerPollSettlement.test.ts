/** @jest-environment node */
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
const mockPersonalList = jest.fn();
const mockBeginClaim = jest.fn();
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => ({
    listClaimablePendingCommands: mockControlList,
  }),
}));
jest.mock("../../src/repositories/personalMediaUploadRepository", () => ({
  getPersonalMediaUploadRepository: () => ({ listClaimable: mockPersonalList }),
}));
jest.mock("../../src/services/runtimeWorkAdmissionService", () => ({
  beginRuntimeWorkClaim: (...args: unknown[]) => mockBeginClaim(...args),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
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
      expect(mockBeginClaim).not.toHaveBeenCalled();
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
