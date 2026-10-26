jest.mock("../../src/services/configService", () => ({
  config: { frontend: { siteUrl: "https://example.invalid" } },
}));
jest.mock("../../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: () => ({ up: "up", down: "down" }),
}));
jest.mock("../../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename",
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => false,
}));
jest.mock("@langfuse/tracing", () => ({ updateActiveObservation: jest.fn() }));
export {};
