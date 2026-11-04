/** @jest-environment node */
import path from "node:path";
import { createArtifactProducerRegistry } from "../../src/services/artifactProducerRegistry";
import type { ArtifactProvenance } from "../../src/types/artifactCleanup";

const owner = {
  guildId: "generated",
  meetingId: "generated-meeting",
  ownerInstanceId: "runtime",
  executionVersion: 1,
};
const directory = path.resolve("generated-artifact-directory");
const audio = {
  kind: "captured_audio",
  producer: "speaker_track",
} satisfies ArtifactProvenance;

test("only registered paths belonging to the exact producer can be attested", () => {
  const registry = createArtifactProducerRegistry();
  const producer = registry.claim({ directory, owner });
  producer.register(path.join(directory, "recording.mp3"), audio);
  expect(producer.freeze()).toMatchObject({
    owner,
    files: [{ path: "recording.mp3", state: "known", provenance: audio }],
  });
  expect(() =>
    producer.register(path.join(directory, "late"), audio),
  ).toThrow();
  expect(() =>
    registry.claim({ directory, owner: { ...owner, executionVersion: 2 } }),
  ).toThrow();
});

test("an active write prevents freezing and a failed write remains uncertain", () => {
  const registry = createArtifactProducerRegistry();
  const producer = registry.claim({ directory, owner });
  const writing = producer.beginWrite(
    path.join(directory, "recording.mp3"),
    audio,
  );
  expect(() => producer.freeze()).toThrow();
  writing.settle("uncertain");
  writing.settle("known");
  expect(producer.freeze().files[0].state).toBe("uncertain");
});

test("sealing prevents new producers while existing writes drain", () => {
  const registry = createArtifactProducerRegistry();
  const producer = registry.claim({ directory, owner });
  const writing = producer.beginWrite(
    path.join(directory, "recording.mp3"),
    audio,
  );
  expect(registry.seal()).toBe(false);
  expect(() =>
    registry.claim({ directory: directory + "-new", owner }),
  ).toThrow();
  writing.settle("known");
  expect(registry.seal()).toBe(true);
  expect(() =>
    producer.beginWrite(path.join(directory, "late"), audio),
  ).toThrow();
  registry.resume();
  expect(
    registry.claim({ directory: directory + "-new", owner }).freeze().files,
  ).toEqual([]);
  expect(() =>
    producer.register(path.join(directory, "late"), audio),
  ).toThrow();
});

test("releasing a cleaned directory cannot reopen its old producer handle", () => {
  const registry = createArtifactProducerRegistry();
  const producer = registry.claim({ directory, owner });
  expect(() => registry.release(directory)).toThrow();
  producer.freeze();
  registry.release(directory);
  expect(registry.get(directory)).toBeUndefined();
  expect(() =>
    producer.register(path.join(directory, "late"), audio),
  ).toThrow();
});

test("producer paths cannot escape or change their declared origin", () => {
  const producer = createArtifactProducerRegistry().claim({ directory, owner });
  expect(() =>
    producer.register(path.resolve(directory, "../outside"), audio),
  ).toThrow();
  producer.register(path.join(directory, "snapshot.json"), {
    kind: "content",
    contentKind: "context",
    sourceId: "context",
    sequence: 1,
    byteLength: 2,
    checksumSha256: "a".repeat(64),
  });
  expect(() =>
    producer.register(path.join(directory, "snapshot.json"), audio),
  ).toThrow();
});
