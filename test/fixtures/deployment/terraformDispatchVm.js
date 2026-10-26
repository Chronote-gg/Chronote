import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import process from "node:process";

/** Execute the real entry point with caller-selected native transport boundaries. */
export async function executeTerraformDispatch(modules, invocationProcess) {
  const realRequire = createRequire(
    join(process.cwd(), "scripts/deployment/terraform-dispatch.cjs"),
  );
  const messages = [];
  await runInNewContext(
    readFileSync("scripts/deployment/terraform-dispatch.cjs", "utf8") +
      "\nmain();",
    {
      require: (name) => modules[name] ?? realRequire(name),
      module: { exports: {} },
      process: invocationProcess,
      console: { log: (value) => messages.push(value) },
      AbortController,
      setTimeout,
      clearTimeout,
    },
  );
  return messages;
}
