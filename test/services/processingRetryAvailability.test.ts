/** @jest-environment node */
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(async () => ({})),
  getSnapshotBoolean: jest.fn(() => true),
}));
jest.mock("../../src/repositories/processingRetryRepository", () => ({
  getProcessingRetryIndexStatus: jest.fn(async () => "ACTIVE"),
}));
import { CONFIG_KEYS } from "../../src/config/keys";
import { getProcessingRetryIndexStatus } from "../../src/repositories/processingRetryRepository";
import { isProcessingRetryAvailable } from "../../src/services/processingRetryAvailability";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "../../src/services/unifiedConfigService";

beforeEach(() => {
  jest.mocked(getSnapshotBoolean).mockReturnValue(true);
  jest.mocked(getProcessingRetryIndexStatus).mockResolvedValue("ACTIVE");
});

it("is available when the global flag is on and the due index is active", async () => {
  expect(await isProcessingRetryAvailable()).toBe(true);
  expect(resolveConfigSnapshot).toHaveBeenCalledWith({});
  expect(getSnapshotBoolean).toHaveBeenCalledWith(
    {},
    CONFIG_KEYS.meetings.processingRetryEnabled,
  );
});

it("is unavailable with the flag off, without describing the table", async () => {
  jest.mocked(getSnapshotBoolean).mockReturnValue(false);
  jest.mocked(getProcessingRetryIndexStatus).mockClear();
  expect(await isProcessingRetryAvailable()).toBe(false);
  expect(getProcessingRetryIndexStatus).not.toHaveBeenCalled();
});

it.each([
  ["still building", async () => "CREATING"],
  ["missing", async () => undefined],
  [
    "unreadable",
    async () => {
      throw new Error("describe failed");
    },
  ],
])("is unavailable while the index is %s", async (_, status) => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.mocked(getProcessingRetryIndexStatus).mockImplementation(status);
  expect(await isProcessingRetryAvailable()).toBe(false);
});
