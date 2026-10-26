"use strict";
const {
  parseRehearsalManifest,
  parseRehearsalAuthorization,
} = require("./rehearsal-manifest.cjs");
const { createIntroductionEngine } = require("./introduce-production.cjs");
const { readArguments } = require("./sandbox-manifest.cjs");
function createRehearsalIntroduction(options) {
  const m = parseRehearsalManifest(options.manifest, options.expectedSha256);
  const engine = createIntroductionEngine(m, options);
  return {
    async run(phase) {
      const authorization =
        phase === "inspect" || !options.probe
          ? undefined
          : parseRehearsalAuthorization(
              options.authorization,
              m,
              options.expectedSha256,
            );
      return engine.run(phase, authorization);
    },
  };
}
function runCli(args = process.argv.slice(2), output = console) {
  try {
    const [phase, ...rest] = args;
    const options = readArguments(rest);
    parseRehearsalManifest(options.manifest, options.expectedSha256);
    // No trusted native ownership collector or separately authorized rehearsal transport exists yet.
    throw new Error(
      `Trusted rehearsal collector and execution authority unavailable: ${phase}`,
    );
  } catch {
    output.error(
      JSON.stringify({
        kind: "rehearsal_introduction_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    return 1;
  }
}
module.exports = { createRehearsalIntroduction, runCli };
if (require.main === module) process.exitCode = runCli();
