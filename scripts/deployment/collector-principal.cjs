"use strict";
const assert = require("node:assert/strict");
async function withinDeadline(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  const expired = new Promise((resolve, reject) => {
    onAbort = () => reject(new Error("UNKNOWN: invocation deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function boundedBody(body, maxBytes, signal) {
  return withinDeadline(readBody(body, maxBytes, signal), signal);
}
async function readBody(body, maxBytes, signal) {
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    assert.ok(length <= maxBytes, "UNKNOWN: response size");
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}
module.exports = { boundedBody };
