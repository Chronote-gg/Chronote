import { createHash } from "node:crypto";
import { createCoordinator } from "../../../scripts/deployment/coordinator.cjs";
import { fixture, env } from "./coordinatorFixture";

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const files = [
  { path: "m/meeting-a/chat.txt", bytes: 3, sha256: sha256("abc") },
  { path: "m/meeting-a/t/track.pcm", bytes: 5, sha256: sha256("audio") },
];
type Head = { ContentLength: number; ChecksumSHA256: string };

export const manifestKey = "recovery/task-old/inventory.json";
/** A coordinator fixture whose source has no artifact row and a verified S3 backup. */
export function legacyFixture(key = manifestKey, source = "/app/tmp/meetings") {
  const f = fixture();
  f.state.artifacts.delete("old");
  f.state.artifactAutoSeal = false;
  const body = Buffer.from(
    JSON.stringify({
      source,
      capturedAt: new Date(900_000).toISOString(),
      layout: "files/<path>",
      files,
    }),
  );
  const objects = new Map<string, Head>(
    files.map((file) => [
      key.slice(0, key.lastIndexOf("/") + 1) + "files/" + file.path,
      {
        ContentLength: file.bytes,
        ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"),
      },
    ]),
  );
  const s3 = jest.fn(async (name: string, input: unknown) => {
    const { Key } = input as { Key: string };
    if (name === "GetObject" && Key === key)
      return { Body: { transformToByteArray: async () => body } };
    const head = objects.get(Key);
    if (name === "HeadObject" && head) return head;
    throw new Error("NoSuchKey");
  });
  f.state.s3 = s3;
  const writes = () =>
    f.calls.filter((call) => call.operation === "transact-write-items").length;
  const attest = (extra: Record<string, string> = {}) =>
    createCoordinator({
      ...f.options,
      env: { ...env, ATTESTATION_MANIFEST_URI: "s3://backup/" + key, ...extra },
    }).attestPreservation();
  return { ...f, body, objects, s3, writes, attest };
}
