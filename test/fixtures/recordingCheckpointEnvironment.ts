import type { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";

export function createCheckpointObjectStore(objects: Map<string, Buffer>) {
  return {
    upload: async (key: string, bytes: string | Uint8Array) => {
      objects.set(key, Buffer.from(bytes));
      return key;
    },
    read: async (key: string) => objects.get(key),
  };
}

export function createCheckpointServiceOverride(
  getReader: () => ReturnType<typeof createRecordingCheckpointService>,
) {
  const actual = jest.requireActual<
    typeof import("../../src/services/recordingCheckpointService")
  >("../../src/services/recordingCheckpointService");
  return {
    createRecordingCheckpointService: (
      ...args: Parameters<typeof createRecordingCheckpointService>
    ) =>
      args.length
        ? actual.createRecordingCheckpointService(...args)
        : getReader(),
  };
}
