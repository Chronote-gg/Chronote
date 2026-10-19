import type { Client } from "discord.js";
import {
  whenRuntimeServing,
  whenOrdinaryAdmissionOpen,
} from "./runtimeLifecycleService";
import { startMeetingControlCommandWorker } from "./meetingControlWorkerService";
import { startMeetingRecoveryWorker } from "./meetingRecoveryWorkerService";
export function registerServingBotStartup(
  client: Client,
  initializeOrdinaryWork: () => void,
) {
  whenRuntimeServing(() => {
    startMeetingControlCommandWorker(client);
    startMeetingRecoveryWorker();
  });
  whenOrdinaryAdmissionOpen(initializeOrdinaryWork);
}
