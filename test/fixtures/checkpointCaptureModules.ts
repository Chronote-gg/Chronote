/**
 * Loads the checkpoint capture modules when a test asks for them, after its
 * clock and mocks are in place, and makes the temporary directory the capture
 * writes to.
 */
export async function loadCheckpointCapture(directoryPrefix: string) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createRecordingCheckpointCapture } =
    await import("../../src/services/recordingCheckpointCapture");
  const { createRecordingCheckpointService } =
    await import("../../src/services/recordingCheckpointService");
  const { createMockMeetingHistoryTransitionRepository } =
    await import("../../src/repositories/meetingHistoryTransitions");
  const { history } = await import("./meetingHistory");
  const directory = mkdtempSync(path.join(tmpdir(), directoryPrefix));
  return {
    directory,
    removeDirectory: () => rmSync(directory, { recursive: true, force: true }),
    createRecordingCheckpointCapture,
    createRecordingCheckpointService,
    createMockMeetingHistoryTransitionRepository,
    history,
  };
}
