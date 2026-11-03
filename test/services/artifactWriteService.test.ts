/** @jest-environment node */
import path from "node:path";
import { createArtifactProducerRegistry } from "../../src/services/artifactProducerRegistry";
import { withArtifactWrite } from "../../src/services/artifactWriteService";

test("the shared writer retains actual ownership until delayed I/O fails", async () => {
  const directory = path.resolve("generated-write-test");
  const producer = createArtifactProducerRegistry().claim({
    directory,
    owner: {
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "worker",
      executionVersion: 1,
    },
  });
  let fail!: (error: Error) => void;
  const io = new Promise<void>((_, reject) => {
    fail = reject;
  });
  const result = withArtifactWrite(
    (filename) => producer.beginWrite(filename, { kind: "stored_input" }),
    path.join(directory, "audio"),
    () => io,
  );
  expect(producer.pendingWrites).toBe(1);
  expect(() => producer.freeze()).toThrow();
  const error = new Error("Late I/O failure");
  const rejected = expect(result).rejects.toBe(error);
  fail(error);
  await rejected;
  expect(producer.pendingWrites).toBe(0);
  expect(producer.freeze().files[0].state).toBe("uncertain");
});
