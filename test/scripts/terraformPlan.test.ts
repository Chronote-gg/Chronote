/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { rmSync } from "node:fs";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
test.each(["full", "purchase-permission", "deployment-prerequisites"])(
  "Terraform %s plan invokes only the selected scope",
  async (scope) => {
    const f = fixture();
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
            : [],
      );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
