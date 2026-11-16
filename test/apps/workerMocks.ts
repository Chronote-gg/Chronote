/** Start-up failures a test asks for; each mock checks it when called. */
export const mockFailures = new Set<string>();
/** A promise the web server set-up waits on, so a test can signal in the middle of start-up. */
export const mockGates: { webServer?: Promise<void> } = {};
/** Every collaborator of the worker entry, mocked so a test can see what start-up and shutdown touch. */
export const mockStarted: string[] = [];
export const mockRegistry = {
  eligible: false,
  listeners: [] as Array<() => void>,
  started: 0,
  stopped: 0,
};

jest.mock("../../src/services/workerRegistry", () => ({
  startWorkerRegistry: async () => {
    mockRegistry.started += 1;
  },
  stopWorkerRegistry: async () => {
    mockRegistry.stopped += 1;
    mockRegistry.eligible = false;
  },
  isEligible: () => mockRegistry.eligible,
  hasBeenReady: () => mockRegistry.started > 0,
  onFirstEligible: (listener: () => void) => {
    mockRegistry.listeners.push(listener);
  },
}));
jest.mock("../../src/bot", () => ({
  setupBot: jest.fn(async () => {
    if (mockFailures.has("login")) throw new Error("synthetic login failure");
    mockStarted.push("login");
  }),
  isBotGatewayReady: () => true,
  startEligibleBotWork: jest.fn(() => mockStarted.push("botWork")),
  destroyBot: jest.fn(async () => {}),
}));
jest.mock("../../src/webserver", () => ({
  setupWebServer: jest.fn(async () => {
    mockStarted.push("webServer");
    await mockGates.webServer;
  }),
}));
export const mockServer = {
  server: { listening: true },
  activate: jest.fn(),
  close: jest.fn(async () => {}),
};
jest.mock("../../src/services/runtimeHealthServer", () => ({
  startRuntimeHealthServer: jest.fn(async () => mockServer),
}));
jest.mock("../../src/services/langfusePromptService", () => ({
  verifyLangfusePrompts: jest.fn(async () => {
    if (mockFailures.has("dependencies"))
      throw new Error("synthetic dependency failure");
  }),
}));
jest.mock("../../src/services/processingRetryWorkerService", () => ({
  startProcessingRetryWorker: jest.fn(() => {
    if (mockFailures.has("processingRetry"))
      throw new Error("synthetic start failure");
    mockStarted.push("processingRetry");
  }),
  stopProcessingRetryWorker: jest.fn(async () => {}),
}));
jest.mock("../../src/services/personalMediaUploadWorkerService", () => ({
  startPersonalMediaUploadWorker: jest.fn(() =>
    mockStarted.push("personalUpload"),
  ),
  stopPersonalMediaUploadWorker: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
  prepareMeetingUpdateDeliveryWorker: jest.fn(async () => {}),
  startMeetingUpdateDeliveryWorker: jest.fn(() =>
    mockStarted.push("meetingUpdate"),
  ),
  stopMeetingUpdateDeliveryWorker: jest.fn(async () => {}),
}));
jest.mock("../../src/services/renewalRecoveryWorkerService", () => ({
  verifyRenewalRecoveryReadiness: jest.fn(async () => {}),
  startRenewalRecoveryWorker: jest.fn(() => mockStarted.push("renewal")),
  stopRenewalRecoveryWorker: jest.fn(async () => {}),
  releaseRenewalRecoveryLease: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingFinisher", () => ({
  ...jest.requireActual<typeof import("../../src/services/meetingFinisher")>(
    "../../src/services/meetingFinisher",
  ),
  startMeetingFinisher: jest.fn(() => mockStarted.push("finisher")),
  stopMeetingFinisher: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  stopMeetingControlCommandWorker: jest.fn(async () => {}),
}));
