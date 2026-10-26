import type { RenewalRecoveryView } from "../../types/renewalRecovery";

export type RenewalGraceDetails = Exclude<
  RenewalRecoveryView,
  { status: "none" }
>;
export function renewalGraceFixture(
  overrides: Partial<RenewalGraceDetails> = {},
): RenewalGraceDetails {
  return {
    status: "grace",
    priorTier: "basic",
    selectedTier: "basic",
    selectedInterval: "month",
    scheduledChange: false,
    endsAt: "2027-10-18T14:00:00.000Z",
    amountDue: 1000,
    currency: "usd",
    paymentUrl: "https://example.invalid/preview-invoice",
    canManage: true,
    ...overrides,
  };
}
