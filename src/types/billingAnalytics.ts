export type BillingLifecycleState = {
  state: "renewal_on" | "renewal_off" | "ended";
  scheduledEnd: string | null;
  tier: "free" | "basic" | "pro" | "unknown";
  interval: "month" | "year" | "unknown";
};
