/** @jest-environment node */
import {
  seedServingRuntime,
  stopServingRuntime,
} from "../fixtures/servingRuntime";

afterEach(async () => {
  await stopServingRuntime();
  jest.restoreAllMocks();
});

test("serving fixture promotes with the current time after startup crosses a second", async () => {
  jest
    .spyOn(Date, "now")
    .mockReturnValue(1_800_000_001_000)
    .mockReturnValueOnce(1_800_000_000_999);

  await expect(seedServingRuntime()).resolves.toBeDefined();
});
