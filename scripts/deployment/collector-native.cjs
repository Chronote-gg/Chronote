"use strict";
const assert = require("node:assert/strict");
// The transport must honor abort and settle after its owned work has stopped.
function nativeTransport(aws, validUntil, now = Date.now) {
  return async (service, operation, input) => {
    const remaining = validUntil * 1000 - now();
    assert.ok(
      Number.isFinite(remaining) && remaining > 0,
      "UNKNOWN: observation expired",
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(30000, Math.ceil(remaining)),
    );
    try {
      const result = await aws(service, operation, input, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      assert.ok(now() < validUntil * 1000, "UNKNOWN: observation expired");
      return result;
    } catch {
      throw new Error(
        `UNKNOWN: native ${service}.${operation} prerequisite unavailable`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
module.exports = { nativeTransport };
