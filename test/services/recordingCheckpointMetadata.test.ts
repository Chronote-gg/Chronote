/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { digest, fixture, input } from "../fixtures/recordingCheckpoint";
test("metadata-only manifest loading never follows context or audio references", async () => {
  const f = fixture();
  const context = Buffer.from("private context must not be read");
  const first = await f.service.flush({
    ...input,
    artifacts: [
      ...input.artifacts,
      {
        kind: "context",
        sourceId: "context",
        sequence: 1,
        coverage: { kind: "unknown" },
        contentType: "application/json",
        bytes: context,
        checksumSha256: digest(context),
      },
    ],
  });
  if (first.kind !== "committed") throw new Error("Fixture checkpoint failed");
  f.read.mockClear();
  const manifest = await f.service.readMetadata(first.checkpoint);
  expect(manifest.artifacts).toHaveLength(2);
  expect(f.read.mock.calls).toEqual([
    [first.checkpoint.manifest.key, undefined],
  ]);
});
