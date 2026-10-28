import { spawnSync } from "node:child_process";
import process from "node:process";

export const prerequisiteGuard =
  "scripts/deployment/validate-prerequisite-plan.cjs";
export const runtimeGuard = "scripts/deployment/validate-runtime-plan.cjs";

// Runs a saved-plan guard CLI on raw stdin text, as the workflows do.
export function runPlanGuard(guard, text, args = []) {
  return spawnSync(process.execPath, [guard, ...args], {
    input: text,
    encoding: "utf8",
  });
}
