"use strict";
const { createHash } = require("node:crypto");
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
module.exports = { digest };
