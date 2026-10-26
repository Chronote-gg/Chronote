import type { Client } from "discord.js";
import {
  whenRuntimeServing,
  whenOrdinaryAdmissionOpen,
  type OrdinaryAdmissionListener,
} from "./runtimeLifecycleService";
import { startMeetingControlCommandWorker } from "./meetingControlWorkerService";
import { startMeetingRecoveryWorker } from "./meetingRecoveryWorkerService";
export function registerServingBotStartup(
  client: Client,
  initializeOrdinaryWork: OrdinaryAdmissionListener,
) {
  whenRuntimeServing(() => {
    startMeetingControlCommandWorker(client);
    startMeetingRecoveryWorker();
  });
  whenOrdinaryAdmissionOpen(initializeOrdinaryWork);
}
