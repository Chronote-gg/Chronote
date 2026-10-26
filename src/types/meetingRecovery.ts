import type { ConsumedFixtureGrant } from "../services/deploymentFixtureAdmission";
import type {
  AdmissionContext,
  ControlTableNames,
  HistoryKey,
} from "./deploymentControl";
import type { ActiveMeetingLease, MeetingHistory } from "./db";
export type RecoveryLease = Extract<
  ActiveMeetingLease,
  { sessionMode: "recovery" }
>;
export type RecoveryClaim = { history: MeetingHistory; lease: RecoveryLease };
export type RecoveryClaimInput = {
  history: MeetingHistory;
  lease: ActiveMeetingLease | undefined;
  context: AdmissionContext;
  attemptId: string;
  fixtureGrant?: ConsumedFixtureGrant;
};
export type RecoveryTables = ControlTableNames & { activeMeeting: string };
export type RecoveryPage = { keys: HistoryKey[]; cursor?: HistoryKey };
export type RecoveryRepository = {
  discoverRecordingRecoveries(cursor?: HistoryKey): Promise<RecoveryPage>;
  claimRecordingRecovery(
    input: RecoveryClaimInput,
  ): Promise<RecoveryClaim | undefined>;
  renewRecordingRecovery(
    claim: RecoveryClaim,
    now: number,
  ): Promise<RecoveryLease | undefined>;
  updateRecordingRecovery(
    claim: RecoveryClaim,
    patch: Partial<
      Pick<
        MeetingHistory,
        | "recoveryExport"
        | "recoveryTranscript"
        | "delivery"
        | "status"
        | "capture"
        | "captureCoverage"
        | "recovery"
        | "processing"
        | "notes"
        | "summarySentence"
        | "summaryLabel"
        | "meetingName"
        | "summaryMessageId"
        | "notesMessageIds"
        | "notesChannelId"
        | "notesDeliveryTiming"
        | "transcriptS3Key"
        | "updatedAt"
      >
    >,
    now: number,
  ): Promise<MeetingHistory | undefined>;
  releaseRecordingRecovery(claim: RecoveryClaim, now: number): Promise<boolean>;
  getRecoveryLease(guildId: string): Promise<ActiveMeetingLease | undefined>;
  saveRecoveryCursor(
    context: AdmissionContext,
    previous: HistoryKey | undefined,
    next: HistoryKey | undefined,
  ): Promise<boolean>;
};

export function recoveryHistoryKey(row: HistoryKey): HistoryKey {
  return { guildId: row.guildId, channelId_timestamp: row.channelId_timestamp };
}
