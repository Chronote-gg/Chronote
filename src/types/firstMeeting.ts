export type FirstMeetingTarget = {
  historyId: string;
  title: string;
  portalUrl: string;
  discordUrl: string | null;
  captureNotice: string | null;
  recoveryNotice: string | null;
};

export type FirstMeetingState =
  | { kind: "guide" }
  | { kind: "recording" | "processing"; meeting: FirstMeetingTarget }
  | { kind: "ready" | "saved"; meeting: FirstMeetingTarget }
  | {
      kind: "delivery_attention";
      delivery: "partial" | "failed";
      meeting: FirstMeetingTarget;
    }
  | {
      kind: "attention";
      reason:
        "interrupted" | "no_notes" | "processing_failed" | "status_unknown";
      meeting: FirstMeetingTarget;
    };
