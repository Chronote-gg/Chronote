/** @jest-environment node */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
let mockDirectory: string;
jest.mock("../../src/services/tempFileService", () => ({
  getMeetingTempDir: () => mockDirectory,
}));
import {
  getMeetingArtifactProducer,
  meetingArtifactProducers,
} from "../../src/services/meetingArtifactProducer";

const meeting = () => ({
  meetingId: "meeting",
  guildId: "guild",
  reservation: {
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "worker",
    executionVersion: 1,
    sessionMode: "meeting" as const,
  },
});
beforeEach(async () => {
  mockDirectory = await fs.mkdtemp(path.join(tmpdir(), "chronote-producer-"));
});
afterEach(async () => {
  if (
    path.dirname(mockDirectory) !== path.resolve(tmpdir()) ||
    !path.basename(mockDirectory).startsWith("chronote-producer-")
  )
    throw new Error("Unexpected test directory");
  await fs.rm(mockDirectory, { recursive: true, force: true });
});
test("one bound handle survives cleanup and keeps old callbacks closed", () => {
  const input = meeting();
  const producer = getMeetingArtifactProducer(input);
  expect(producer).toBeDefined();
  expect(getMeetingArtifactProducer(input)).toBe(producer);
  producer!.freeze();
  meetingArtifactProducers.release(mockDirectory);
  expect(getMeetingArtifactProducer(input)).toBe(producer);
  expect(() =>
    producer!.register(path.join(mockDirectory, "late"), {
      kind: "stored_input",
    }),
  ).toThrow();
});
test("pre-existing data cannot be adopted by a new producer", async () => {
  await fs.writeFile(path.join(mockDirectory, "unknown"), "unknown");
  expect(() => getMeetingArtifactProducer(meeting())).toThrow();
});
test("missing or changed reservation never supplies inferred provenance", () => {
  expect(
    getMeetingArtifactProducer({ guildId: "guild", meetingId: "meeting" }),
  ).toBeUndefined();
  const input = meeting();
  getMeetingArtifactProducer(input);
  input.reservation.executionVersion = 2;
  expect(() => getMeetingArtifactProducer(input)).toThrow();
});
