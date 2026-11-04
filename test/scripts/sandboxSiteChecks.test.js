/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSandboxSitePermissionsPlan } from "../../scripts/deployment/validate-sandbox-site-permissions-plan.cjs";
import { copyModelSource } from "../fixtures/deployment/terraformMeetingNative.js";
import {
  sitePermissionsPlan,
  permissionBinding,
} from "../fixtures/deployment/sandboxSitePermissionsPlan.js";

const relevant = [
  "aws_iam_policy.site_publishing",
  "aws_iam_role.production_deploy",
  "aws_iam_role.sandbox_deploy",
  "var.ENABLE_API_ALB",
  "var.docs_distribution_id",
  "var.frontend_distribution_id",
];
const outside = [
  "aws_cloudfront_distribution.docs",
  "aws_cloudfront_distribution.frontend",
  "aws_elasticache_replication_group.redis",
  "aws_iam_role.production_acceptance_collector",
  "aws_iam_role.production_introduction",
  "aws_iam_role_policy.production_launcher_reads",
  "var.ECS_DESIRED_COUNT",
  "var.grafana_token_rotation_days",
  "var.production_acceptance_fixtures",
  "var.production_introduction_reviewed_policy_arns",
  "var.production_introduction_route_role_arns",
  "var.production_introduction_standalone_tasks",
  "var.production_introduction_task_definitions",
];
const descriptor = (display) => {
  const [type, name] = display.split(".");
  return type === "var"
    ? { kind: "var", name, to_display: display }
    : { kind: "resource", mode: "managed", type, name, to_display: display };
};
// Source identities and public mock values only, never private plan bytes.
function targetedPlan() {
  const p = sitePermissionsPlan();
  p.checks = [
    ...outside.map((name) => ({
      address: descriptor(name),
      status: "unknown",
    })),
    ...relevant.map((name) => {
      const check = { address: descriptor(name), status: "pass" };
      if (name !== "aws_iam_role.production_deploy")
        check.instances = [
          {
            address: name.startsWith("var.")
              ? { to_display: name }
              : { to_display: `${name}[0]`, instance_key: 0 },
            status: "pass",
          },
        ];
      return check;
    }),
  ];
  const policy = p.resource_changes.find(
    (r) => r.address === "aws_iam_policy.site_publishing[0]",
  );
  policy.change.after.tags = null;
  policy.change.after_unknown.tags_all = {};
  return p;
}
const validate = (p, options) =>
  validateSandboxSitePermissionsPlan(p, permissionBinding(), options);

test("accepts source-proven targeted unknown checks and known default tags", () => {
  expect(validate(targetedPlan())).toEqual({
    result: "accepted",
    changes: [
      { address: "aws_iam_policy.site_publishing[0]", action: "create" },
      {
        address: "aws_iam_role_policy_attachment.site_publishing[0]",
        action: "create",
      },
    ],
  });
});

test.each([
  [
    "foreign passed descriptor",
    (p) => {
      p.checks[0] = {
        address: descriptor("aws_dynamodb_table.meeting_history_table"),
        status: "pass",
      };
    },
  ],
  [
    "duplicate descriptor",
    (p) => {
      p.checks.push(structuredClone(p.checks[0]));
    },
  ],
  [
    "wrong descriptor kind",
    (p) => {
      p.checks[0].address.kind = "output";
    },
  ],
  [
    "wrong descriptor name",
    (p) => {
      p.checks[0].address.name = "other";
    },
  ],
  [
    "unknown descriptor property",
    (p) => {
      p.checks[0].address.extra = true;
    },
  ],
  [
    "unknown check property",
    (p) => {
      p.checks[0].extra = true;
    },
  ],
  [
    "failed outside check",
    (p) => {
      p.checks[0].status = "fail";
    },
  ],
  [
    "error outside check",
    (p) => {
      p.checks[0].status = "error";
    },
  ],
  [
    "unknown instances",
    (p) => {
      p.checks[0].instances = [];
    },
  ],
  [
    "null instances",
    (p) => {
      p.checks[0].instances = null;
    },
  ],
  [
    "failed passed instance",
    (p) => {
      p.checks.at(-1).instances[0].status = "fail";
    },
  ],
  [
    "foreign instance",
    (p) => {
      p.checks.at(-1).instances[0].address.to_display = "var.other";
    },
  ],
  [
    "duplicate instance",
    (p) => {
      p.checks
        .at(-1)
        .instances.push(structuredClone(p.checks.at(-1).instances[0]));
    },
  ],
  [
    "unbound resource instance",
    (p) => {
      const c = p.checks.find(
        (c) => c.address.to_display === "aws_iam_role.sandbox_deploy",
      );
      c.instances[0].address = {
        to_display: "aws_iam_role.sandbox_deploy[1]",
        instance_key: 1,
      };
    },
  ],
  [
    "missing resource instances",
    (p) => {
      delete p.checks.find(
        (c) => c.address.to_display === "aws_iam_role.sandbox_deploy",
      ).instances;
    },
  ],
  [
    "keyed variable instance",
    (p) => {
      const c = p.checks.at(-1);
      c.instances[0].address = {
        to_display: c.address.to_display + "[0]",
        instance_key: 0,
      };
    },
  ],
  [
    "extra no-op resource",
    (p) => {
      const r = structuredClone(p.resource_changes[0]);
      r.address = "aws_cloudfront_distribution.docs";
      p.resource_changes.push(r);
    },
  ],
  [
    "deferred change",
    (p) => {
      p.deferred_changes = [{}];
    },
  ],
  [
    "unknown policy",
    (p) => {
      p.resource_changes.find(
        (r) => r.address === "aws_iam_policy.site_publishing[0]",
      ).change.after_unknown.policy = true;
    },
  ],
  [
    "unknown default tag",
    (p) => {
      p.resource_changes.find(
        (r) => r.address === "aws_iam_policy.site_publishing[0]",
      ).change.after_unknown.tags_all = { Project: true };
    },
  ],
])("refuses targeted-check bypass: %s", (_name, mutate) => {
  const p = targetedPlan();
  mutate(p);
  expect(() => validate(p)).toThrow();
});

test.each(relevant)("relevant check must pass: %s", (name) => {
  const p = targetedPlan();
  const c = p.checks.find((c) => c.address.to_display === name);
  c.status = "unknown";
  delete c.instances;
  expect(() => validate(p)).toThrow();
});

test("targeted unknown checks cannot hide a missing relevant descriptor", () => {
  const p = targetedPlan();
  p.checks = p.checks.filter(
    (c) => c.address.to_display !== "aws_iam_role.sandbox_deploy",
  );
  expect(() => validate(p)).toThrow();
});

test("unknown checks bind the requested source commit", () => {
  expect(() =>
    validate(targetedPlan(), { sourceSha: "0".repeat(40) }),
  ).toThrow();
});

test.each(["unbound", "changed", "override.tf", "new.tf"])(
  "unknown checks need the audited committed source: %s",
  (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "site-check-source-"));
    mkdirSync(join(directory, "_infra"));
    try {
      if (mode !== "unbound") copyModelSource(directory);
      const file = mode === "changed" ? "main.tf" : mode;
      writeFileSync(join(directory, "_infra", file), "# unaudited\n");
      expect(() => validate(targetedPlan(), { directory })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
