/**
 * Mocked claim repositories the worker poller suites share. Each suite keeps its own
 * jest.mock call and returns one of these from the factory, because jest hoists
 * mocks per test file.
 */
export const pollerRepository = {
  controlList: jest.fn(),
  controlClaim: jest.fn(),
  personalList: jest.fn(),
  personalClaim: jest.fn(),
};

export const meetingControlCommandRepositoryModule = {
  getMeetingControlCommandRepository: () => ({
    listClaimablePendingCommands: pollerRepository.controlList,
    claimCommand: pollerRepository.controlClaim,
  }),
};

export const personalMediaUploadRepositoryModule = {
  getPersonalMediaUploadRepository: () => ({
    listClaimable: pollerRepository.personalList,
    claim: pollerRepository.personalClaim,
  }),
};
