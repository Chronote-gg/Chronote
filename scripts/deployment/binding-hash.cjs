"use strict";
const { createHash } = require("node:crypto");
function bindingHash(binding) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(binding)))
    .digest("hex");
}
module.exports = { bindingHash };
