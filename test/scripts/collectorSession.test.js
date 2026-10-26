/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { decodeCollectorStream } from "../../scripts/deployment/collector-session.cjs";
import { digest } from "../../scripts/deployment/collector-payload.cjs";
function stream() {
  const request = {
    nonce: "nonce",
    inputSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
  };
  const frames = [];
  const add = (type, value) =>
    frames.push(
      JSON.stringify({
        protocol: "chronote-collector-v1",
        ...request,
        sequence: frames.length,
        type,
        value,
      }),
    );
  add("start", { taskArn: "task" });
  add("result", { kind: "metadata" });
  add("result", { kind: "identity" });
  for (const name of [
    "meetingAcquire",
    "uploadClaim",
    "uploadRenew",
    "uploadProgress",
    "meetingRelease",
    "meetingRenew",
  ])
    add("result", { kind: "probe", name });
  add("terminal", {
    status: "complete",
    count: frames.length,
    digest: digest(frames.join("\n") + "\n"),
  });
  return {
    request,
    frames,
    text:
      "\nStarting session with SessionId: ecs-session\n" +
      frames.join("\n") +
      "\n",
  };
}
test("accepts the exact session banner and complete sequenced payload with CRLF only", () => {
  const f = stream();
  expect(
    decodeCollectorStream(
      f.text.replaceAll("\n", "\r\n"),
      f.request,
      "ecs-session",
    ),
  ).toHaveLength(8);
});
test.each([
  "session",
  "nonce",
  "duplicate",
  "lost",
  "junk",
  "ansi",
  "order",
  "digest",
])("rejects %s stream without accepting a partial result", (fault) => {
  const f = stream();
  let text = f.text;
  if (fault === "session") text = text.replace("ecs-session", "foreign");
  if (fault === "nonce")
    text = text.replace('nonce":"nonce', 'nonce":"foreign');
  if (fault === "duplicate") text += f.frames[0] + "\n";
  if (fault === "lost") text = text.slice(0, -20);
  if (fault === "junk") text += "junk";
  if (fault === "ansi") text = "\u001b[0m" + text;
  if (fault === "order") text = text.replace(f.frames[1], f.frames[2]);
  if (fault === "digest") text = text.replace(/"digest":"./, '"digest":"z');
  expect(() => decodeCollectorStream(text, f.request, "ecs-session")).toThrow();
});
