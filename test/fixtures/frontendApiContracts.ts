// Literal browser requests frozen from legacy 593a6d6 and current ae9ec8b source.
// These revisions are source evidence, not claims about the bundle served live.
export const billingRequests = [
  {
    client: "legacy",
    method: "GET",
    path: "billing.me",
    input: {},
    expected: { billingEnabled: false, tier: "free" },
  },
  {
    client: "legacy",
    method: "GET",
    path: "billing.me",
    input: { serverId: "111111111111111111" },
    expected: { billingEnabled: true, tier: "basic" },
  },
  {
    client: "legacy",
    method: "POST",
    path: "billing.checkout",
    input: { serverId: "111111111111111111", tier: "basic" },
    expected: { url: "https://checkout.invalid/month/automatic" },
  },
  {
    client: "legacy",
    method: "POST",
    path: "billing.checkout",
    input: { serverId: "111111111111111111", tier: "pro", interval: "month" },
    expected: { url: "https://checkout.invalid/month/automatic" },
  },
  {
    client: "legacy",
    method: "POST",
    path: "billing.checkout",
    input: { serverId: "111111111111111111", tier: "basic", interval: "year" },
    expected: { url: "https://checkout.invalid/year/automatic" },
  },
  {
    client: "legacy",
    method: "POST",
    path: "billing.portal",
    input: { serverId: "111111111111111111" },
    expected: { url: "https://billing.invalid/portal" },
  },
  {
    client: "legacy",
    method: "GET",
    path: "billing.renewal",
    input: { serverId: "111111111111111111" },
    expected: {
      state: { kind: "not_applicable" },
      canManageBilling: false,
      lifecycleAnalyticsEnabled: false,
    },
  },
  {
    client: "legacy",
    method: "POST",
    path: "billing.reactivateRenewal",
    input: {
      serverId: "111111111111111111",
      request: { kind: "confirm", quoteToken: "synthetic-expired-quote" },
    },
    expected: { kind: "changed" },
  },
  {
    client: "current",
    method: "GET",
    path: "billing.me",
    input: { serverId: "111111111111111111" },
    expected: { billingEnabled: true, tier: "basic" },
  },
  {
    client: "current",
    method: "POST",
    path: "billing.checkout",
    input: {
      serverId: "111111111111111111",
      tier: "basic",
      interval: "year",
      expectedOffer: "none",
      offerChoice: "automatic",
      source: "billing",
    },
    expected: { url: "https://checkout.invalid/year/automatic" },
  },
  {
    client: "current",
    method: "GET",
    path: "billing.change",
    input: { serverId: "111111111111111111" },
    expected: { kind: "none", enabled: false },
  },
  {
    client: "current",
    method: "POST",
    path: "billing.reactivateRenewal",
    input: {
      serverId: "111111111111111111",
      request: {
        kind: "recover",
        operationId: "00000000-0000-4000-8000-000000000001",
      },
    },
    expected: { kind: "changed" },
  },
];
export const firstMeetingRequests = [
  { serverId: "111111111111111111" },
  {
    serverId: "111111111111111111",
    historyId: "222222222222222222#2026-10-19T12:00:00.000Z",
  },
];
export const firstMeetingTarget = {
  historyId: "222222222222222222#2026-10-19T12:00:00.000Z",
  title: "Local contract fixture",
  portalUrl: "/portal/server/111111111111111111/meeting/fixture",
  discordUrl: null,
  captureNotice: null,
  recoveryNotice: null,
};
