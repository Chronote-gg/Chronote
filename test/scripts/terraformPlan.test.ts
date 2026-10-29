/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { rmSync } from "node:fs";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
import { runtimePlan } from "../fixtures/deployment/runtimePlan.js";
test.each([
  "full",
  "purchase-permission",
  "deployment-prerequisites",
  "deployment-runtime",
])("Terraform %s plan invokes only the selected scope", async (scope) => {
  const f = fixture();
  if (scope === "deployment-runtime") f.controls.planJson = runtimePlan();
  try {
    const result = await runTerraform(f.options({ ...invocation, scope }));
    expect(result.status).toBe("planned-changes");
    const plans = f.commands.filter((command) => command.args[1] === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].args).toContain("-out=tfplan");
    expect(plans[0].args.filter((arg) => arg.startsWith("-target="))).toEqual(
      scope === "purchase-permission"
        ? ["-target=aws_iam_role_policy.initial_purchase_condition"]
        : scope === "deployment-prerequisites"
          ? [
              "-target=aws_dynamodb_table.deployment_control_table",
              "-target=aws_lb_target_group.api_spare_tg[0]",
              "-target=aws_iam_role_policy.deployment_control",
              "-target=aws_iam_policy.deployment_routing[0]",
            ]
          : scope === "deployment-runtime"
            ? [
                "-target=aws_iam_role.production_deploy[0]",
                "-target=aws_iam_role_policy.production_deploy[0]",
                "-target=aws_iam_role_policy_attachment.production_deploy_routing[0]",
                "-target=aws_iam_policy.site_publishing[0]",
                "-target=aws_iam_role_policy_attachment.site_publishing[0]",
                "-target=aws_iam_role_policy.production_exec_channels[0]",
                "-target=aws_iam_policy.dynamodb_access_policy",
                "-target=aws_dynamodb_table.guild_subscription_table",
                "-target=aws_lb_target_group.api_tg[0]",
                "-target=aws_lb_target_group.api_spare_tg[0]",
                '-target=aws_iam_role.production_introduction["prompt-guard"]',
                "-target=aws_iam_role_policy.production_prompt_guard[0]",
              ]
            : [],
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
