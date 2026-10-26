export type DeliveryPhase = "processing" | "summary" | "notes" | "cancellation";

export type DeliveryResult = {
  intended: number;
  sent: number;
  errors: { code?: number; status?: number }[];
} & (
  | {
      outcome: "sent_fallback";
      recoveredMissingMessage?: { code: 10008; status: 404 };
    }
  | {
      outcome:
        | "edited_existing"
        | "complete"
        | "partial"
        | "failed"
        | "not_applicable";
    }
);

export type MeetingDelivery = Partial<Record<DeliveryPhase, DeliveryResult>>;
