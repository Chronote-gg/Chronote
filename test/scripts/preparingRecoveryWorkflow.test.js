/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import process from "node:process";
const workflow = parse(
  readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
);
const validation = workflow.jobs.identity.steps
  .find((step) => step.name === "Validate exclusive operation inputs")
  .run.split("node <<'NODE'\n")[1]
  .split("\nNODE")[0];
function validate(extra = {}) {
  execFileSync(process.execPath, ["-e", validation], {
    env: {
      GITHUB_RUN_ATTEMPT: "1",
      CONTINUATION_ACTION: "inspect-preparing",
      CARRYFORWARD_MANIFEST_SHA256: "a".repeat(64),
      PREPARING_RECOVERY_PROOF_SHA256: "b".repeat(64),
      ...extra,
    },
    stdio: "pipe",
  });
}
test("preparing recovery has distinct inspection/execution actions and private proof transport inside the unchanged gate", () => {
  expect(
    workflow.on.workflow_dispatch.inputs.continuation_action.options,
  ).toEqual(expect.arrayContaining(["inspect-preparing", "recover-preparing"]));
  expect(workflow.concurrency).toEqual({
    group: "chronote-deploy-sandbox",
    "cancel-in-progress": false,
  });
  expect(workflow.jobs.continuation.environment).toBe("sandbox");
  const step = workflow.jobs.continuation.steps.find(
    (s) => s.name === "Execute only the selected continuation action",
  );
  expect(step.env.PREPARING_RECOVERY_PROOF_JSON).toContain(
    "secrets.SANDBOX_PREPARING_RECOVERY_PROOF",
  );
  expect(step.run).toContain("recover-preparing-sandbox.cjs inspect");
  expect(step.run).toContain("recover-preparing-sandbox.cjs recover");
  expect(() => validate()).not.toThrow();
  expect(() =>
    validate({
      CONTINUATION_ACTION: "recover-preparing",
      CONTINUATION_BINDING_SHA256: "c".repeat(64),
    }),
  ).not.toThrow();
});
test.each([
  { PREPARING_RECOVERY_PROOF_SHA256: "" },
  { CARRYFORWARD_MANIFEST_SHA256: "" },
  { BOOTSTRAP_PHASE: "prepare" },
  { GITHUB_RUN_ATTEMPT: "2" },
  { CONTINUATION_ACTION: "recover-preparing" },
  {
    CONTINUATION_ACTION: "carryforward",
    CONTINUATION_BINDING_SHA256: "c".repeat(64),
  },
  { SOURCE_LOSS_TERMINAL_PROOF_SHA256: "d".repeat(64) },
])("incompatible or incomplete preparing input refuses: %j", (extra) => {
  expect(() => validate(extra)).toThrow();
});
