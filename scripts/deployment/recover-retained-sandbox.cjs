"use strict";
const { recoverSandbox, runRecoveryCli } = require("./recover-sandbox.cjs");
const { createRetainedStopProof } = require("./retained-stop-proof.cjs");
async function recoverRetainedSandbox(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const terminalProof = createRetainedStopProof({
    json: env.SOURCE_LOSS_TERMINAL_PROOF_JSON,
    expectedSha256: env.SOURCE_LOSS_TERMINAL_PROOF_SHA256,
    env,
    now,
  });
  return recoverSandbox({ ...options, env, now, terminalProof });
}
module.exports = { recoverRetainedSandbox };
if (require.main === module)
  runRecoveryCli(
    recoverRetainedSandbox,
    process.argv[2],
    "retained_source_loss_recovery_failed",
  );
