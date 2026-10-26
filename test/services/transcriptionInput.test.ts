/** @jest-environment node */
import { Readable } from "node:stream";
import { withTranscriptionInput } from "../../src/services/transcriptionInput";
const mockOpen = jest.fn();
jest.mock("node:fs", () => ({
  createReadStream: (...args: unknown[]) => mockOpen(...args),
}));
test("a completed provider response still owns its input until actual stream close", async () => {
  let close!: () => void;
  const stream = new Readable({
    read() {},
    destroy(_error, done) {
      close = () => done();
    },
  });
  mockOpen.mockReturnValueOnce(stream);
  let settled = false;
  const task = withTranscriptionInput(
    "synthetic",
    async () => "provider response",
  ).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(stream.destroyed).toBe(true);
  expect(stream.closed).toBe(false);
  expect(settled).toBe(false);
  close();
  await expect(task).resolves.toBe("provider response");
  expect(stream.closed).toBe(true);
});

test("a causal read error wrapped by the SDK becomes typed local provenance", async () => {
  const readError = new Error("synthetic EIO");
  const sdkError = new Error("connection wrapper", { cause: readError });
  const stream = new Readable({ read() {} });
  mockOpen.mockReturnValueOnce(stream);
  let failure: unknown;
  try {
    await withTranscriptionInput("synthetic", async (file) => {
      file.emit("error", readError);
      throw sdkError;
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "TranscriptionInputError",
    cause: sdkError,
  });
  expect(stream.closed).toBe(true);
});

test("a successful request cannot hide an observed read error", async () => {
  const readError = new Error("synthetic read failure");
  const stream = new Readable({ read() {} });
  mockOpen.mockReturnValueOnce(stream);
  await expect(
    withTranscriptionInput("synthetic", async (file) => {
      file.emit("error", readError);
      return "response";
    }),
  ).rejects.toMatchObject({
    name: "TranscriptionInputError",
    cause: readError,
  });
  expect(stream.closed).toBe(true);
});

test.each(["provider", "cancellation", "cyclic cause"])(
  "preserves %s rejection over a secondary teardown error",
  async (kind) => {
    const original = new Error("original rejection");
    if (kind === "cancellation") original.name = "AbortError";
    if (kind === "cyclic cause") original.cause = original;
    const stream = new Readable({
      read() {},
      destroy(_error, done) {
        done(new Error("secondary teardown"));
      },
    });
    mockOpen.mockReturnValueOnce(stream);
    await expect(
      withTranscriptionInput("synthetic", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(stream.closed).toBe(true);
  },
);
