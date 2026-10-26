export type BillingRejectionReason =
  | "transition_guarded"
  | "offer_unavailable"
  | "offer_changed_terms"
  | "discount_choice_required"
  | "purchase_pending"
  | "purchase_needs_review"
  | "purchase_expired";

export class BillingActionError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "BAD_REQUEST",
    message: string,
    public readonly reason: BillingRejectionReason = "transition_guarded",
  ) {
    super(message);
    this.name = "BillingActionError";
  }
}
