export type DeliveryPhase = "processing" | "summary" | "notes" | "cancellation";

export type DeliveryResult = {
  outcome:
    | "edited_existing"
    | "sent_fallback"
    | "complete"
    | "partial"
    | "failed"
    | "not_applicable";
  intended: number;
  sent: number;
  errors: { code?: number; status?: number }[];
};

export type MeetingDelivery = Partial<Record<DeliveryPhase, DeliveryResult>>;
