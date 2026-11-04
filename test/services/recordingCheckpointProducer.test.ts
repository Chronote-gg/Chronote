/** @jest-environment node */

jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import {
  fixture,
  input,
  ownership,
  segment,
} from "../fixtures/recordingCheckpoint";

test("producer no-op retains the saved unknown-coverage timestamp", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
  try {
    const f = fixture();
    const producer = f.service.createProducerSession();
    const signal = new AbortController().signal;
    const first = await producer.flush({
      ...input,
      ownership,
      signal,
      artifacts: [{ ...segment, coverage: { kind: "unknown" } }],
    });
    if (first.kind !== "committed")
      throw new Error("Expected first checkpoint");
    jest.setSystemTime(new Date("2026-01-01T00:00:11.000Z"));
    const unchanged = await producer.flush({
      ...input,
      ownership,
      signal,
      previous: first.checkpoint,
      artifacts: [],
    });
    expect(unchanged).toMatchObject({
      kind: "committed",
      checkpoint: first.checkpoint,
    });
    jest.setSystemTime(new Date("2026-01-01T00:00:12.000Z"));
    const next = await producer.flush({
      ...input,
      ownership,
      signal,
      previous: first.checkpoint,
      artifacts: [{ ...segment, sequence: 1 }],
    });
    expect(next.kind).toBe("committed");
  } finally {
    jest.useRealTimers();
  }
});
