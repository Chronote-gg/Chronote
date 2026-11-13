/**
 * Mocked collaborators of the meeting embeds that the delivery suites share.
 * Each suite keeps its own jest.mock call and returns one of these from the
 * factory, because jest hoists mocks per test file.
 */
export const summaryUpgradeServiceModule = {
  claimSummaryUpgrade: jest.fn(),
};

export const analyticsServiceModule = {
  captureEvent: jest.fn(),
};
