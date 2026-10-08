/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

test.each(["full", "purchase-permission"])(
  "Terraform %s plan invokes only the selected scope",
  (scope) => {
    const workflow = parse(
      readFileSync(".github/workflows/terraform-plan.yml", "utf8"),
    );
    const command = workflow.jobs.plan.steps.find(
      (step: { name: string }) => step.name === "Terraform plan",
    ).run;
    const directory = mkdtempSync(join(tmpdir(), "chronote-plan-"));
    mkdirSync(join(directory, "_infra"));
    try {
      execFileSync(
        "bash",
        [
          "-c",
          `terraform() { printf '%s\\n' "$@" > arguments.txt; }; ${command}`,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PLAN_SCOPE: scope,
            GITHUB_OUTPUT: "output.txt",
          },
        },
      );
      const args = readFileSync(join(directory, "arguments.txt"), "utf8")
        .trim()
        .split("\n");
      expect(args).toContain("plan");
      expect(args).toContain("-out=tfplan");
      expect(args.filter((arg) => arg.startsWith("-target="))).toEqual(
        scope === "purchase-permission"
          ? ["-target=aws_iam_role_policy.initial_purchase_condition"]
          : [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
