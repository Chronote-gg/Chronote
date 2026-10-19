/** @jest-environment node */
import { Client } from "discord.js";
import { registerServingBotStartup } from "../../src/services/botStartupService";
import {
  whenRuntimeServing,
  whenOrdinaryAdmissionOpen,
} from "../../src/services/runtimeLifecycleService";
import { startMeetingControlCommandWorker } from "../../src/services/meetingControlWorkerService";
import { startMeetingRecoveryWorker } from "../../src/services/meetingRecoveryWorkerService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  whenRuntimeServing: jest.fn(),
  whenOrdinaryAdmissionOpen: jest.fn(),
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  startMeetingControlCommandWorker: jest.fn(),
}));
jest.mock("../../src/services/meetingRecoveryWorkerService", () => ({
  startMeetingRecoveryWorker: jest.fn(),
}));
test("serving starts fixture workers while ordinary startup waits for the release callback", () => {
  const client = new Client({ intents: [] });
  const initialize = jest.fn();
  registerServingBotStartup(client, initialize);
  jest.mocked(whenRuntimeServing).mock.calls[0][0]();
  expect(startMeetingControlCommandWorker).toHaveBeenCalledWith(client);
  expect(startMeetingRecoveryWorker).toHaveBeenCalledTimes(1);
  expect(initialize).not.toHaveBeenCalled();
  const acknowledgeAdmission = jest.fn();
  jest.mocked(whenOrdinaryAdmissionOpen).mock.calls[0][0](acknowledgeAdmission);
  expect(initialize).toHaveBeenCalledWith(acknowledgeAdmission);
});
