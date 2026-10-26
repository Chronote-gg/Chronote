"use strict";
// Polling is scheduling only. Each consumer still authenticates its own source.
async function waitWithinOriginalPreparation(poll) {
  if (process.env.GITHUB_JOB !== "prepare-acceptance")
    throw Error("acceptance_prepare_prerequisite");
  const loader = require("./production-private-package.cjs");
  const loaded = await loader.loadAcceptancePackage();
  const binding = loader.readCollectionBinding(loaded.collection);
  const deadline =
    1000 *
    Math.min(
      binding.manifest.acceptance.prepareDeadline,
      binding.manifest.validUntil,
    );
  for (;;) {
    loader.readCollectionBinding(loaded.collection);
    if (Date.now() >= deadline) throw Error("acceptance_prepare_expired");
    try {
      const value = await poll(binding);
      loader.readCollectionBinding(loaded.collection);
      if (Date.now() >= deadline) throw Error("acceptance_prepare_expired");
      return value;
    } catch {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error("acceptance_prepare_expired");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(15000, remaining)),
      );
    }
  }
}
module.exports = { waitWithinOriginalPreparation };
