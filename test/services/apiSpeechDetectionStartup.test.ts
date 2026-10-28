/** @jest-environment node */
jest.mock("../../src/observability/langfuseInstrumentation", () => ({}));

it("loads the API bootstrap and real bot without starting a detector child or loading ONNX", async () => {
  const workerSpawn = jest.fn(() => {
    throw Error("Unexpected detector worker");
  });
  const runtimeLoad = jest.fn(() => {
    throw Error("Unexpected ONNX import");
  });
  jest.doMock("node:child_process", () => ({
    ...jest.requireActual<typeof import("node:child_process")>(
      "node:child_process",
    ),
    fork: workerSpawn,
  }));
  jest.doMock("onnxruntime-node", runtimeLoad);
  try {
    const { bootstrapApp } = await import("../../src/apps/bootstrap");
    expect(typeof bootstrapApp).toBe("function");
    expect(workerSpawn).not.toHaveBeenCalled();
    expect(runtimeLoad).not.toHaveBeenCalled();
  } finally {
    jest.dontMock("node:child_process");
    jest.dontMock("onnxruntime-node");
  }
});
