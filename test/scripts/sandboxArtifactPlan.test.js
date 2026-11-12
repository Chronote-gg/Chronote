/** @jest-environment node */
import { test, expect, beforeAll, afterAll } from "@jest/globals";
import { Buffer } from "node:buffer";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateArtifactPreservationPlan,
  prepareSandboxArtifactSession,
  sandboxArtifactBinding,
} from "../../scripts/deployment/validate-artifact-preservation-plan.cjs";
import {
  sandboxArtifactPlan,
  artifactBinding,
  artifactPolicy,
  artifactAttachment,
  artifactRole,
} from "../fixtures/deployment/sandboxArtifactPlan.js";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import { parseInvocation } from "../../scripts/deployment/terraform-bundle.cjs";
import { parse } from "yaml";
import { prepareSandboxSitePermissionSession } from "../../scripts/deployment/validate-sandbox-site-permissions-plan.cjs";
import { permissionBinding } from "../fixtures/deployment/sandboxSitePermissionsPlan.js";
import { expectedRolePolicy } from "../../_infra/sandbox-bootstrap/policy-contracts.cjs";
import bootstrapBinding from "../../_infra/sandbox-bootstrap/tests/fixtures/reviewed-binding.json";
let directory, sourceSha;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "artifact-source-"));
  mkdirSync(join(directory, "_infra"));
  for (const name of readdirSync("_infra").filter(
    (n) => /\.tf(?:\.json)?$/.test(n) || n === ".terraform.lock.hcl",
  ))
    copyFileSync(join("_infra", name), join(directory, "_infra", name));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, stdio: "pipe" })
      .toString()
      .trim();
  git("init");
  git("add", "_infra");
  git(
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Exact Terraform source fixture",
  );
  sourceSha = git("rev-parse", "HEAD");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const validate = (p) =>
  validateArtifactPreservationPlan(p, artifactBinding, {
    directory,
    sourceSha,
  });

test("accepts a known empty tags_all unknown mask with exact approved tags", () => {
  const plan = sandboxArtifactPlan();
  const change = plan.resource_changes.find(
    (resource) => resource.address === artifactPolicy,
  ).change;
  change.after_unknown.tags_all = {};
  change.after.tags_all = {
    Project: "meeting-notes",
    Environment: "sandbox",
    ManagedBy: "terraform",
    Service: "chronote",
  };
  expect(validate(plan).result).toBe("accepted");
});

test.each([null, [], { Environment: false }, { Environment: true }, "false"])(
  "rejects malformed or nonempty tags_all mask %p",
  (mask) => {
    const plan = sandboxArtifactPlan();
    entry(plan, artifactPolicy).change.after_unknown.tags_all = mask;
    expect(() => validate(plan)).toThrow();
  },
);

test("rejects object masks for other computed fields", () => {
  const plan = sandboxArtifactPlan();
  entry(plan, artifactPolicy).change.after_unknown.attachment_count = {};
  expect(() => validate(plan)).toThrow();
});

test("requires exact actual tags for known tags_all masks", () => {
  for (const mask of [{}, false]) {
    const plan = sandboxArtifactPlan();
    const change = entry(plan, artifactPolicy).change;
    change.after_unknown.tags_all = mask;
    change.after.tags_all = {
      Project: "meeting-notes",
      Environment: "production",
      ManagedBy: "terraform",
      Service: "chronote",
    };
    expect(() => validate(plan)).toThrow();
    change.after.tags_all.Environment = "sandbox";
    expect(validate(plan).result).toBe("accepted");
  }
});
const entry = (p, address) =>
  p.resource_changes.find((r) => r.address === address);
test("accepts native targeted completeness while refusing errors and deferred work", () => {
  const p = sandboxArtifactPlan();
  Object.assign(p, { applyable: true, complete: false, errored: false });
  expect(validate(p).result).toBe("accepted");
  expect(() => validate({ ...p, errored: true })).toThrow();
  expect(() => validate({ ...p, deferred_changes: [{}] })).toThrow();
});
test("binds passing variable checks to their exact declared instance", () => {
  const p = sandboxArtifactPlan();
  const check = p.checks.find(
    (c) => c.address.to_display === "var.ENABLE_API_ALB",
  );
  check.status = "pass";
  check.instances = [
    { address: { to_display: check.address.to_display }, status: "pass" },
  ];
  expect(validate(p).result).toBe("accepted");
  check.instances = [];
  expect(() => validate(p)).toThrow();
});
test("accepts only the exact three writes and known equal deploy role", () => {
  expect(validate(sandboxArtifactPlan()).changes).toEqual([
    { address: "aws_iam_policy.transcripts_s3_policy", action: "update" },
    { address: artifactPolicy, action: "create" },
    { address: artifactAttachment, action: "create" },
  ]);
});
test.each([
  [
    "completed scope",
    (p) => {
      for (const r of p.resource_changes) r.change.actions = ["no-op"];
    },
  ],
  [
    "role write",
    (p) => {
      entry(p, artifactRole).change.actions = ["update"];
    },
  ],
  [
    "changed role",
    (p) => {
      entry(p, artifactRole).change.after.assume_role_policy += "x";
    },
  ],
  [
    "unknown role dependency",
    (p) => {
      entry(p, artifactRole).change.after_unknown.arn = true;
    },
  ],
  [
    "foreign resource",
    (p) => {
      p.resource_changes.push({
        ...structuredClone(entry(p, artifactRole)),
        address: "aws_iam_role.other",
      });
    },
  ],
  [
    "duplicate resource",
    (p) => {
      p.resource_changes.push(structuredClone(p.resource_changes[0]));
    },
  ],
  [
    "move",
    (p) => {
      p.resource_changes[0].previous_address = "aws_iam_policy.old";
    },
  ],
  [
    "import",
    (p) => {
      p.resource_changes[0].change.importing = { id: "old" };
    },
  ],
  [
    "replacement",
    (p) => {
      p.resource_changes[0].change.actions = ["delete", "create"];
    },
  ],
  [
    "unknown JSON",
    (p) => {
      entry(p, artifactPolicy).change.after_unknown.policy = true;
    },
  ],
  [
    "extra grant",
    (p) => {
      const r = entry(p, artifactPolicy);
      r.change.after.policy = r.change.after.policy.replace(
        "dynamodb:ConditionCheckItem",
        "dynamodb:*",
      );
    },
  ],
  [
    "changed bucket",
    (p) => {
      p.resource_changes[0].change.after.policy =
        p.resource_changes[0].change.after.policy.replaceAll(
          "transcripts",
          "other",
        );
    },
  ],
  [
    "changed transcript metadata",
    (p) => {
      p.resource_changes[0].change.after.description = "new";
    },
  ],
  [
    "unknown attachment role",
    (p) => {
      entry(p, artifactAttachment).change.after_unknown.role = true;
    },
  ],
  [
    "foreign attachment ARN",
    (p) => {
      entry(p, artifactAttachment).change.after.policy_arn =
        "arn:aws:iam::123456789012:policy/other";
    },
  ],
  [
    "indirect reference",
    (p) => {
      p.configuration.root_module.resources[0].expressions.policy_arn.references.pop();
    },
  ],
  [
    "missing checks",
    (p) => {
      p.checks = [];
    },
  ],
  [
    "unknown included check",
    (p) => {
      p.checks.find((c) => c.status === "pass").status = "unknown";
    },
  ],
  [
    "wrong check instance",
    (p) => {
      p.checks.find(
        (c) => c.status === "pass",
      ).instances[0].address.instance_key = 1;
    },
  ],
  [
    "drift",
    (p) => {
      p.resource_drift = [{}];
    },
  ],
])("refuses %s", (_name, change) => {
  const p = sandboxArtifactPlan();
  change(p);
  expect(() => validate(p)).toThrow();
});
test("refuses changed source even with a known attachment ARN", () => {
  const file = join(directory, "_infra/sandbox-artifact-authority.tf"),
    source = readFileSync(file);
  writeFileSync(file, source.toString() + "\n# altered\n");
  try {
    expect(() => validate(sandboxArtifactPlan())).toThrow();
  } finally {
    writeFileSync(file, source);
  }
});
test("refuses foreign caller identity in an otherwise known unchanged dependency", () => {
  const p = sandboxArtifactPlan(),
    values = { account_id: "999999999999" };
  p.resource_changes.push({
    address: "data.aws_caller_identity.current",
    mode: "data",
    change: {
      actions: ["no-op"],
      before: JSON.parse(JSON.stringify(values)),
      after: values,
      after_unknown: {},
    },
  });
  expect(() => validate(p)).toThrow();
});
test("accepts exact known identifiers and unchanged same-account metadata", () => {
  const p = sandboxArtifactPlan(),
    arn =
      "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-artifact-authority";
  const created = entry(p, artifactPolicy).change;
  for (const key of ["arn", "id"]) {
    created.after[key] = arn;
    created.after_unknown[key] = false;
  }
  const attached = entry(p, artifactAttachment).change;
  attached.after.policy_arn = arn;
  attached.after_unknown.policy_arn = false;
  const caller = { account_id: artifactBinding.accountId };
  p.resource_changes.push({
    address: "data.aws_caller_identity.current",
    mode: "data",
    change: {
      actions: ["no-op"],
      before: JSON.parse(JSON.stringify(caller)),
      after: caller,
      after_unknown: {},
    },
  });
  expect(validate(p).result).toBe("accepted");
});
test("binds exact account, region and executor/deploy selectors", () => {
  const vars = {
    AWS_ACCOUNT_ID: artifactBinding.accountId,
    AWS_REGION: "us-east-1",
    TERRAFORM_AWS_ROLE_ARN:
      "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-terraform",
    SANDBOX_BACKEND_DEPLOY_ROLE_ARN:
      "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy",
  };
  expect(sandboxArtifactBinding(privateCaptureFixture().binding, vars)).toEqual(
    artifactBinding,
  );
  expect(() =>
    sandboxArtifactBinding(privateCaptureFixture().binding, {
      ...vars,
      SANDBOX_BACKEND_DEPLOY_ROLE_ARN: vars.TERRAFORM_AWS_ROLE_ARN,
    }),
  ).toThrow();
  for (const phase of ["plan", "apply"])
    expect(
      Buffer.byteLength(
        prepareSandboxArtifactSession(artifactBinding, phase).policy,
      ),
    ).toBeLessThanOrEqual(2048);
});
test("admits Sandbox artifact scope only in the Sandbox workspace", () => {
  const input = {
    repository: "Chronote-gg/Chronote",
    sourceSha: "a".repeat(40),
    workflowPath: ".github/workflows/terraform-plan.yml",
    runId: "10",
    runAttempt: 1,
    environment: "sandbox",
    workspace: "sandbox",
    scope: "artifact-preservation",
  };
  expect(parseInvocation(input)).toEqual(input);
  expect(() => parseInvocation({ ...input, workspace: "default" })).toThrow();
});

// Evaluate only the operators emitted by these session and executor contracts.
test("IAM matcher preserves literal resource punctuation and ARN case", () => {
  const policy = {
    Statement: [
      {
        Effect: "Allow",
        Action: "iam:GetPolicy",
        Resource: "arn:aws:iam::123456789012:policy/artifact.v1",
      },
    ],
  };
  expect(
    allows(
      policy,
      "IAM:GETPOLICY",
      "arn:aws:iam::123456789012:policy/artifact.v1",
    ),
  ).toBe(true);
  expect(
    allows(
      policy,
      "iam:GetPolicy",
      "arn:aws:iam::123456789012:policy/artifactXv1",
    ),
  ).toBe(false);
  expect(
    allows(
      policy,
      "iam:GetPolicy",
      "arn:aws:iam::123456789012:POLICY/artifact.v1",
    ),
  ).toBe(false);
});
function allows(policy, action, resource, policyArn) {
  const match = (pattern, value, ignoreCase = false) =>
    new RegExp(
      "^" + pattern.split("*").map(RegExp.escape).join(".*") + "$",
      ignoreCase ? "i" : "",
    ).test(value);
  const any = (values, value, ignoreCase = false) =>
    [values].flat().some((v) => match(v, value, ignoreCase));
  const applies = (s) =>
    (s.NotAction
      ? !any(s.NotAction, action, true)
      : any(s.Action, action, true)) &&
    (s.NotResource
      ? !any(s.NotResource, resource)
      : any(s.Resource, resource)) &&
    (!s.Condition?.StringEquals?.["iam:PolicyARN"] ||
      policyArn === s.Condition.StringEquals["iam:PolicyARN"]) &&
    (!s.Condition?.StringNotEquals ||
      policyArn !== s.Condition.StringNotEquals["iam:PolicyARN"]);
  return (
    policy.Statement.some((s) => s.Effect === "Allow" && applies(s)) &&
    !policy.Statement.some((s) => s.Effect === "Deny" && applies(s))
  );
}
test("artifact sessions intersect the executor into exact writes and preserve site isolation", () => {
  const base = expectedRolePolicy(bootstrapBinding.variables);
  const prefix = "arn:aws:iam::123456789012:",
    authority = prefix + "policy/meeting-notes-sandbox-artifact-authority",
    transcript =
      prefix + "policy/meeting-notes-sandbox-bot-transcripts-s3-policy",
    role = prefix + "role/meeting-notes-sandbox-github-deploy";
  const operations = [
    ["iam:CreatePolicyVersion", transcript, undefined, true],
    ["iam:CreatePolicy", authority, undefined, true],
    ["iam:TagPolicy", authority, undefined, true],
    ["iam:AttachRolePolicy", role, authority, true],
    ["iam:AttachRolePolicy", role, undefined, false],
    ["iam:AttachRolePolicy", role, transcript, false],
    ["iam:AttachRolePolicy", role + "-other", authority, false],
    ["iam:CreatePolicyVersion", authority, undefined, false],
    ["iam:CreatePolicy", transcript, undefined, false],
    ["iam:PutRolePolicy", role, undefined, false],
    ["iam:DeletePolicyVersion", transcript, undefined, false],
    [
      "dynamodb:UpdateTable",
      "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable",
      undefined,
      false,
    ],
  ];
  for (const phase of ["plan", "apply"]) {
    const session = JSON.parse(
      prepareSandboxArtifactSession(artifactBinding, phase).policy,
    );
    for (const [action, resource, arn, expected] of operations)
      expect(
        allows(base, action, resource, arn) &&
          allows(session, action, resource, arn),
      ).toBe(phase === "apply" && expected);
    expect(allows(session, "iam:GetPolicy", transcript)).toBe(true);
  }
  const site = JSON.parse(
    prepareSandboxSitePermissionSession(permissionBinding()).policy,
  );
  expect(
    allows(base, "iam:AttachRolePolicy", role, authority) &&
      allows(site, "iam:AttachRolePolicy", role, authority),
  ).toBe(false);
  expect(allows(site, "iam:CreatePolicyVersion", transcript)).toBe(false);
});
test.each(["plan", "apply"])(
  "%s workflow binds an artifact session before credentials",
  (phase) => {
    const workflow = parse(
      readFileSync(`.github/workflows/terraform-${phase}.yml`, "utf8"),
    );
    const steps = workflow.jobs[phase].steps;
    const terraform = steps.filter((s) =>
      s.uses?.startsWith("hashicorp/setup-terraform@"),
    );
    expect(terraform).toHaveLength(1);
    expect(terraform[0].with.terraform_version).toBe("1.17.1");
    const prepared = steps.findIndex((s) => s.id === "artifact-session");
    const credential = steps.findIndex(
      (s) =>
        s.uses?.startsWith("aws-actions/configure-aws-credentials") &&
        s.with?.["inline-session-policy"]?.includes(
          "steps.artifact-session.outputs.policy",
        ),
    );
    expect(prepared).toBeGreaterThan(
      steps.findIndex((s) => s.name === "Validate Terraform dispatch scope"),
    );
    expect(credential).toBeGreaterThan(prepared);
    expect(steps[prepared].run).toBe(
      `node scripts/deployment/validate-artifact-preservation-plan.cjs --session ${phase}`,
    );
    expect(steps[prepared].if).toContain(
      "inputs.plan_scope == 'artifact-preservation'",
    );
    expect(
      workflow.on.workflow_dispatch.inputs.plan_scope.description,
    ).toContain("artifact-preservation");
  },
);
