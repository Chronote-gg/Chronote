jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("./runtimeApiOperation")
    .runTestApiOperation,
}));
export {};
