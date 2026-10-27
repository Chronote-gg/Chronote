import { Buffer } from "node:buffer";
export function privateFileResponse(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    type: "file",
    path,
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}
