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
import { pollerRepository } from "./workerPollerModules.fixture";

const {
  controlList: mockControlList,
  controlClaim: mockControlClaim,
  personalList: mockPersonalList,
  personalClaim: mockPersonalClaim,
} = pollerRepository;
function mockPollerModules() {
  return jest.requireActual<typeof import("./workerPollerModules.fixture")>(
    "./workerPollerModules.fixture",
  );
}
jest.mock(
  "../../src/repositories/meetingControlCommandRepository",
  () => mockPollerModules().meetingControlCommandRepositoryModule,
);
jest.mock(
  "../../src/repositories/personalMediaUploadRepository",
  () => mockPollerModules().personalMediaUploadRepositoryModule,
);
jest.mock("../../src/services/meetingControlBotService");
jest.mock("../../src/services/personalMediaUploadProcessingService");
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-worker",
}));
jest.mock("../../src/db", () => ({ personalMediaClaimForJob: jest.fn() }));
test.each(["control", "personal"] as const)(
  "%s worker stop owns held list completion and prevents late claims or restart",
  async (domain) => {
    jest.useFakeTimers();
    const list = Promise.withResolvers<unknown[]>();
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
