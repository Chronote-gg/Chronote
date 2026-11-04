import { spawnSync } from "node:child_process";
import process from "node:process";

export const prerequisiteGuard =
  "scripts/deployment/validate-prerequisite-plan.cjs";
export const runtimeGuard = "scripts/deployment/validate-runtime-plan.cjs";
export const siteGuard = "scripts/deployment/validate-site-plan.cjs";

export function findChange(plan, address) {
  const resource = plan.resource_changes.find((r) => r.address === address);
  if (!resource) throw new Error(`missing ${address}`);
  return resource;
}
export function dropResource(plan, address) {
  plan.resource_changes = plan.resource_changes.filter(
    (r) => r.address !== address,
  );
}
// Models a scope that was already applied: every managed resource is a no-op.
export function markAllNoOp(plan) {
  for (const resource of plan.resource_changes)
    if (resource.mode === "managed") resource.change = { actions: ["no-op"] };
  return plan;
}
// Replaces any planned action at `address` with an out-of-scope update.
export function forceUpdate(plan, address) {
  dropResource(plan, address);
  plan.resource_changes.push({
    address,
    mode: "managed",
    change: { actions: ["update"] },
  });
}

// Runs a saved-plan guard CLI on raw stdin text, as the workflows do.
export function runPlanGuard(guard, text, args = []) {
  return spawnSync(process.execPath, [guard, ...args], {
    input: text,
    encoding: "utf8",
  });
}
