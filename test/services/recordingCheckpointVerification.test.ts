/** @jest-environment node */

jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import {
  digest,
  segment,
  fixture,
  input,
} from "../fixtures/recordingCheckpoint";

async function savedContextCheckpoint(count: number) {
  const f = fixture();
  const bytes = Buffer.from("{}");
  const artifacts = Array.from({ length: count }, (_, sequence) => ({
    ...segment,
    kind: "context" as const,
    sequence,
    bytes,
    checksumSha256: digest(bytes),
    contentType: "application/json",
  }));
  const saved = await f.service.flush({ ...input, artifacts });
  if (saved.kind !== "committed") throw new Error("fixture commit failed");
  return { ...f, checkpoint: saved.checkpoint };
}

test("failed verification settles issued reads and never dispatches the next batch", async () => {
  const f = await savedContextCheckpoint(20);
  const { manifest } = await f.service.read(f.checkpoint);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  f.read.mockClear();
  f.read.mockImplementation(async (key) => {
    if (key === f.checkpoint.manifest.key) return f.objects.get(key);
    if (key === manifest.artifacts[0].object.key)
      throw new Error("Synthetic read failure");
    await pending;
    return f.objects.get(key);
  });
  const reading = f.service.read(f.checkpoint).then(
    () => {
      completed = true;
      return "fulfilled";
    },
    () => {
      completed = true;
      return "rejected";
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(
      f.read.mock.calls.filter(([key]) => key !== f.checkpoint.manifest.key),
    ).toHaveLength(16);
    release();
    expect(await reading).toBe("rejected");
    expect(
      f.read.mock.calls.filter(([key]) => key !== f.checkpoint.manifest.key),
    ).toHaveLength(16);
  } finally {
    release();
    await reading;
  }
});

test("parallel verification preserves order and rejects absent, wrong-size and same-size corrupt objects", async () => {
  const f = await savedContextCheckpoint(20);
  const { manifest } = await f.service.read(f.checkpoint);
  f.objects.delete(manifest.artifacts[1].object.key);
  f.objects.set(manifest.artifacts[8].object.key, Buffer.from("[ ]"));
  f.objects.set(manifest.artifacts[17].object.key, Buffer.from("[]"));
  const verified = await f.service.read(f.checkpoint);
  expect(verified.missing.map(({ sequence }) => sequence)).toEqual([1, 8, 17]);
  expect(verified.verified.map(({ sequence }) => sequence)).toEqual([
    0, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19,
  ]);
});
