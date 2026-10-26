"use strict";
const { execFile } = require("node:child_process");
function executeChild(file, args, options) {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure, stdout;
    const child = execFile(file, args, options, (error, output) => {
      failure = error;
      stdout = output;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", () => {
      if (failure) reject(failure);
      else resolve({ stdout });
    });
  });
}
module.exports = { executeChild };
