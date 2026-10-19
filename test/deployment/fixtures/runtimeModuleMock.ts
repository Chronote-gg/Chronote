export const createRuntimeModuleMock = () => ({
  ...jest.requireActual("../../../src/services/runtimeLifecycleService"),
  beginRuntimeWork: jest.fn(),
  getRuntimeAdmissionContext: jest.fn(),
});
