export class BillingActionError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "BillingActionError";
  }
}
