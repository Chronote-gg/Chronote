/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { rmSync } from "node:fs";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
import { runtimePlan } from "../fixtures/deployment/runtimePlan.js";
import { sitePlan } from "../fixtures/deployment/sitePlan.js";
import { processingRetryPlan } from "../fixtures/deployment/processingRetryPlan.js";
// Each scope's fixture plan (if it needs one) and its exact -target arguments.
const scopes: Record<string, { plan?: () => unknown; targets: string[] }> = {
  full: { targets: [] },
  "purchase-permission": {
    targets: ["-target=aws_iam_role_policy.initial_purchase_condition"],
  },
  "deployment-prerequisites": {
    targets: [
      "-target=aws_dynamodb_table.deployment_control_table",
      "-target=aws_lb_target_group.api_spare_tg[0]",
      "-target=aws_iam_role_policy.deployment_control",
      "-target=aws_iam_policy.deployment_routing[0]",
    ],
  },
  "deployment-runtime": {
    plan: runtimePlan,
    targets: [
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
    ],
  },
  "site-delivery": {
    plan: sitePlan,
    targets: [
      "-target=aws_cloudfront_function.frontend_route_rewrite",
      "-target=aws_cloudfront_response_headers_policy.crawler_noindex",
      "-target=aws_cloudfront_distribution.frontend",
      "-target=aws_cloudfront_distribution.docs",
    ],
  },
  "processing-retry": {
    plan: processingRetryPlan,
    targets: [
      "-target=aws_dynamodb_table.meeting_history_table",
      "-target=aws_cloudwatch_log_metric_filter.processing_retry_worker_failed[0]",
      "-target=aws_cloudwatch_metric_alarm.processing_retry_worker_failed[0]",
    ],
  },
};
test.each(Object.keys(scopes))(
  "Terraform %s plan invokes only the selected scope",
  async (scope) => {
    const { plan, targets } = scopes[scope];
    const f = fixture();
    if (plan) f.controls.planJson = plan();
    try {
      const result = await runTerraform(f.options({ ...invocation, scope }));
      expect(result.status).toBe("planned-changes");
      const plans = f.commands.filter((command) => command.args[1] === "plan");
      expect(plans).toHaveLength(1);
      expect(plans[0].args).toContain("-out=tfplan");
      expect(plans[0].args.filter((arg) => arg.startsWith("-target="))).toEqual(
        targets,
      );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
