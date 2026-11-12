/**
 * Module stand-ins for the steps a meeting end takes before close. Test files
 * hand them to their own `jest.mock` factories, since a mock only applies in
 * the file that declares it; each test file loads its own copy.
 */
export const processingMessageEmbed = {
  updateMeetingProcessingMessage: jest.fn(async () => ({})),
};

export const joinSuppression = {
  autoRecordJoinSuppressionService: {
    suppressUntilEmpty: jest.fn(async () => true),
  },
};
