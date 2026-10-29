/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
import { meetingUpdatePlan } from "../fixtures/deployment/terraformMeetingUpdate.js";
import {
  nativeMeetingPlan,
  installationRecords,
  copyModelSource,
} from "../fixtures/deployment/terraformMeetingNative.js";
import {
  quietSandboxPlan,
  tableAddress,
} from "../fixtures/deployment/processingRetryPlan.js";
const sandbox = {
  ...invocation,
  environment: "sandbox",
  workspace: "sandbox",
  scope: "meeting-update-delivery",
};
// Clears the plan workspace like a fresh runner, then applies the reviewed bundle.
async function applySandbox(f, planOptions, plan, beforeApply) {
  const reference = JSON.parse(
    readFileSync(
      join(planOptions.privateDirectory, "bundle-reference.json"),
      "utf8",
    ),
  );
  for (const name of readdirSync(join(f.directory, "_infra")))
    if (
      ![".terraform.lock.hcl", "terraform.auto.tfvars.json"].includes(name) &&
      !/\.tf(?:\.json)?$/.test(name)
    )
      rmSync(join(f.directory, "_infra", name));
  beforeApply();
  const { scope } = planOptions.invocation;
  f.controls.applyTitle = `Terraform Apply sandbox/sandbox/${scope} plan=10 plan-sha=${plan.planSha256} bundle-sha=${plan.bundleSha256}`;
  return runTerraform({
    ...f.options({
      ...sandbox,
      sourceSha: planOptions.invocation.sourceSha,
      scope,
      workflowPath: ".github/workflows/terraform-apply.yml",
      runId: "20",
    }),
    producerRunId: "10",
    command: planOptions.command,
    artifactName: "terraform-plan-sandbox-sandbox-10",
    reference,
    planSha256: plan.planSha256,
    bundleSha256: plan.bundleSha256,
  });
}
test.each([
  "none",
  "plan-delta",
  "apply-delta",
  "missing-workspace",
  "plan-data-source",
  "apply-data-source",
  "plan-known-warm",
  "apply-known-warm",
])(
  "delivery boundary %s uses a private rendering of the exact saved plan",
  async (fault) => {
    const f = fixture();
    f.controls.environment = "sandbox";
    f.controls.planJson = meetingUpdatePlan();
    if (fault === "plan-delta")
      f.controls.planJson.resource_changes[0].change.after.tags.Name =
        "changed";
    if (fault === "missing-workspace") f.controls.fail = "workspace";
    const injectData = () =>
      f.controls.planJson.resource_changes.push({
        address: "data.external.unreviewed",
        type: "external",
        name: "unreviewed",
        mode: "data",
        provider_name: "registry.terraform.io/hashicorp/external",
        change: {
          actions: ["read"],
          before: null,
          after: {},
          after_unknown: {},
        },
      });
    if (fault === "plan-data-source") injectData();
    const injectKnownWarm = () => {
      for (const phase of ["before", "after"])
        f.controls.planJson.resource_changes[0].change[
          phase
        ].global_secondary_index.find(
          (index) => index.name === "GuildTimestampIndex",
        ).warm_throughput = [
          { read_units_per_second: 1, write_units_per_second: 1 },
        ];
    };
    if (fault === "plan-known-warm") injectKnownWarm();
    const planRejected = [
      "plan-delta",
      "plan-data-source",
      "missing-workspace",
      "plan-known-warm",
    ].includes(fault);
    const applyRejected = [
      "apply-delta",
      "apply-data-source",
      "apply-known-warm",
    ].includes(fault);
    try {
      const planOptions = f.options(sandbox);
      const plan = await runTerraform(planOptions);
      if (planRejected) {
        expect(plan.status).toBe("failed");
        expect(readdirSync(planOptions.privateDirectory)).not.toContain(
          "bundle-reference.json",
        );
        expect(
          f.commands.some(
            (c) => c.args[1] === "workspace" && c.args[2] === "new",
          ),
        ).toBe(false);
        return;
      }
      expect(plan.status).toBe("planned-changes");
      const targets = f.commands
        .find((c) => c.args[1] === "plan")
        .args.filter((a) => a.startsWith("-target="));
      expect(targets).toEqual([
        "-target=aws_dynamodb_table.meeting_history_table",
        "-target=aws_iam_policy.dynamodb_access_policy",
      ]);
      expect(JSON.stringify(plan)).not.toMatch(
        /MeetingHistory|123456789012|bucket|versionId/,
      );
      const result = await applySandbox(f, planOptions, plan, () => {
        if (fault === "apply-delta")
          f.controls.planJson.resource_changes[1].change.after.tags = {
            unreviewed: "true",
          };
        if (fault === "apply-data-source") injectData();
        if (fault === "apply-known-warm") injectKnownWarm();
      });
      expect(result.status).toBe(applyRejected ? "refused" : "applied");
      expect(
        f.commands.filter(
          (c) => c.args[1] === "show" && c.args.includes("-json"),
        ),
      ).toHaveLength(2);
      expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
        applyRejected ? 0 : 1,
      );
      expect(readFileSync(join(f.directory, "_infra/tfplan"))).toEqual(
        Buffer.from([0, 255, 13, 10]),
      );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each(
  ["plan", "apply"].flatMap((mode) =>
    [
      "full",
      "purchase-permission",
      "deployment-prerequisites",
      "deployment-runtime",
      "site-delivery",
      undefined,
    ].map((scope) => [mode, scope]),
  ),
)(
  "direct Sandbox %s refuses scope %s before storage, native metadata or commands",
  async (mode, scope) => {
    const f = fixture(),
      effects = [];
    try {
      const options = f.options({
        ...sandbox,
        scope,
        workflowPath: `.github/workflows/terraform-${mode}.yml`,
      });
      const result = await runTerraform({
        ...options,
        client: {
          ...options.client,
          send: async () => {
            effects.push("storage");
            throw new Error("unexpected storage");
          },
        },
        get: async () => {
          effects.push("native metadata");
          throw new Error("unexpected native metadata");
        },
        command: async () => {
          effects.push("command");
          throw new Error("unexpected command");
        },
      });
      expect(result).toEqual({ status: "refused" });
      expect(effects).toEqual([]);
      expect(f.storage.objects.size).toBe(0);
      expect(f.commands).toEqual([]);
      expect(readdirSync(options.privateDirectory)).not.toContain(
        "bundle-reference.json",
      );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["applies", false],
  ["refuses a restored plan with a second new index", true],
])("Sandbox processing retry %s", async (_name, drift) => {
  const f = fixture();
  f.controls.environment = "sandbox";
  f.controls.planJson = quietSandboxPlan();
  const retry = { ...sandbox, scope: "processing-retry" };
  try {
    const planOptions = f.options(retry);
    const plan = await runTerraform(planOptions);
    expect(plan.status).toBe("planned-changes");
    const result = await applySandbox(f, planOptions, plan, () => {
      if (!drift) return;
      const indexes = f.controls.planJson.resource_changes.find(
        (r) => r.address === tableAddress,
      ).change.after.global_secondary_index;
      indexes.push({ ...indexes.at(-1), name: "UnreviewedIndex" });
    });
    expect(result.status).toBe(drift ? "refused" : "applied");
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
      drift ? 0 : 1,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test.each([
  "none",
  "omit-installation",
  "wrong-provider",
  "missing-source",
  "wrong-run-source",
])("native delivery workflow %s", async (fault) => {
  const f = fixture();
  f.controls.environment = "sandbox";
  f.controls.planJson = nativeMeetingPlan();
  const sourceSha = copyModelSource(f.directory);
  f.controls.producerSha = sourceSha;
  f.controls.applySha = sourceSha;
  if (fault === "missing-source") rmSync(join(f.directory, "_infra/main.tf"));
  try {
    const options = f.options({ ...sandbox, sourceSha });
    const command = options.command;
    options.command = async (...args) => {
      const record = await command(...args);
      if (record.command === "terraform" && record.args[1] === "version") {
        const data = JSON.parse(
          Buffer.from(installationRecords()[1].stdout, "base64").toString(),
        );
        if (fault === "omit-installation") delete data.provider_selections;
        if (fault === "wrong-provider")
          data.provider_selections["registry.terraform.io/hashicorp/aws"] =
            "6.70.0";
        record.stdout = Buffer.from(JSON.stringify(data)).toString("base64");
      }
      return record;
    };
    if (fault === "wrong-run-source") f.controls.producerSha = "0".repeat(40);
    const result = await runTerraform(options);
    if (fault === "none" && result.status !== "planned-changes")
      throw new Error(
        readFileSync(join(options.privateDirectory, "failure.txt"), "utf8"),
      );
    expect(result.status).toBe(fault === "none" ? "planned-changes" : "failed");
    expect(
      readdirSync(options.privateDirectory).includes("bundle-reference.json"),
    ).toBe(fault === "none");
    expect(f.commands.some((c) => c.args[1] === "apply")).toBe(false);
    if (fault === "none") {
      const applied = await applySandbox(f, options, result, () => {});
      expect(applied.status).toBe("applied");
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
