/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  validateSandboxSitePermissionsPlan,
  sandboxSitePermissionsBinding,
  prepareSandboxSitePermissionSession,
  sandboxSitePermissionsTargets,
} from "../../scripts/deployment/validate-sandbox-site-permissions-plan.cjs";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import bootstrapPlan from "../../_infra/sandbox-bootstrap/tests/fixtures/create-plan.json";
import {
  sitePermissionsPlan,
  permissionBinding,
  siteVariables,
  sitePolicy,
  policyAddress,
  attachmentAddress,
  roleAddress,
  policyArn,
} from "../fixtures/deployment/sandboxSitePermissionsPlan.js";
const validate = (plan) =>
  validateSandboxSitePermissionsPlan(plan, permissionBinding());
const resource = (plan, address = policyAddress) =>
  plan.resource_changes.find((r) => r.address === address);
test.each([
  "reviewed",
  "crlf",
  "wrapped",
  "comment",
  "override.tf",
  "extra_override.tf",
  "override.tf.json",
  "extra_override.tf.json",
])(
  "unknown attachment ARN requires reviewed direct-reference source: %s",
  (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "site-permission-source-"));
    mkdirSync(join(directory, "_infra"));
    let source = readFileSync("_infra/site-publishing.tf", "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    if (mode === "crlf") source = source.replaceAll("\n", "\r\n");
    if (mode === "wrapped")
      source = source.replace(
        "policy_arn = aws_iam_policy.site_publishing[0].arn",
        'policy_arn = join("", [aws_iam_policy.site_publishing[0].arn])',
      );
    if (mode === "comment")
      source += "\n# policy_arn = aws_iam_policy.site_publishing[0].arn\n";
    writeFileSync(join(directory, "_infra/site-publishing.tf"), source);
    if (mode.includes("override"))
      writeFileSync(join(directory, "_infra", mode), "{}");
    try {
      const check = () =>
        validateSandboxSitePermissionsPlan(
          sitePermissionsPlan(),
          permissionBinding(),
          { directory },
        );
      if (["reviewed", "crlf"].includes(mode)) expect(check).not.toThrow();
      else expect(check).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test.each(["create", "update", "no-op"])(
  "accepts a complete validated %s",
  (action) => {
    expect(validate(sitePermissionsPlan(action))).toEqual({
      result: "accepted",
      changes:
        action === "no-op"
          ? []
          : [
              { address: policyAddress, action },
              ...(action === "create"
                ? [{ address: attachmentAddress, action }]
                : []),
            ],
    });
    expect([...sandboxSitePermissionsTargets.keys()]).toEqual([
      policyAddress,
      attachmentAddress,
    ]);
  },
);
const faults = {
  empty: (p) => {
    p.resource_changes = [];
  },
  missing: (p) => {
    p.resource_changes.pop();
  },
  duplicate: (p) => {
    p.resource_changes.push(structuredClone(resource(p)));
  },
  delete: (p) => {
    resource(p).change.actions = ["delete"];
  },
  replacement: (p) => {
    resource(p).change.actions = ["delete", "create"];
  },
  import: (p) => {
    resource(p).change.importing = { id: policyArn };
  },
  move: (p) => {
    resource(p).previous_address = "aws_iam_policy.other";
  },
  unrelated: (p) => {
    p.resource_changes.push({
      address: "aws_dynamodb_table.other",
      mode: "managed",
      change: { actions: ["update"] },
    });
  },
  drift: (p) => {
    p.resource_drift = [structuredClone(resource(p))];
  },
  failedCheck: (p) => {
    p.checks = [{ status: "fail" }];
  },
  unknownCheck: (p) => {
    p.checks = [{ status: "unknown" }];
  },
  errored: (p) => {
    p.errored = true;
  },
  unknownPolicy: (p) => {
    resource(p).change.after_unknown.policy = true;
  },
  unknownRole: (p) => {
    resource(p, attachmentAddress).change.after_unknown.role = true;
  },
  arbitraryExpression: (p) => {
    p.configuration.root_module.resources[0].expressions.policy_arn = {
      references: ["var.policy_arn"],
    };
  },
  wrongKnownArn: (p) => {
    resource(p, attachmentAddress).change.after.policy_arn =
      "arn:aws:iam::123456789012:policy/other";
    resource(p, attachmentAddress).change.after_unknown.policy_arn = false;
  },
  contradictoryPolicyArn: (p) => {
    resource(p).change.after.arn = "arn:aws:iam::123456789012:policy/other";
  },
  contradictoryAttachmentArn: (p) => {
    resource(p, attachmentAddress).change.after.policy_arn =
      "arn:aws:iam::123456789012:policy/other";
  },
  dataTarget: (p) => {
    resource(p).mode = "data";
    resource(p).change.actions = ["read"];
  },
  wrongRole: (p) => {
    resource(p, attachmentAddress).change.after.role = "other";
  },
  wrongEnvironment: (p) => {
    p.variables.environment.value = "prod";
  },
  wrongProject: (p) => {
    p.variables.project_name.value = "other";
  },
  wrongDistribution: (p) => {
    p.variables.docs_distribution_id.value = "EOTHER";
  },
  unknownIdOnUpdate: (p) => {
    resource(p).change.actions = ["update"];
    resource(p).change.before = { ...resource(p).change.after };
  },
};
for (const address of [
  "aws_s3_bucket.frontend",
  "aws_s3_bucket.docs",
  "aws_kms_key.app_general",
  roleAddress,
]) {
  faults[`missing ${address}`] = (p) => {
    p.resource_changes = p.resource_changes.filter(
      (r) => r.address !== address,
    );
  };
  faults[`unknown ${address}`] = (p) => {
    resource(p, address).change.after_unknown = true;
  };
  faults[`changed ${address}`] = (p) => {
    resource(p, address).change.after.extra = "changed";
  };
}
test.each(Object.entries(faults))("refuses %s", (_name, mutate) => {
  const p = sitePermissionsPlan();
  mutate(p);
  expect(() => validate(p)).toThrow();
});
test.each(["create", "no-op"])(
  "validates exact policy even during %s",
  (action) => {
    for (const mutate of [
      (p) => p.Statement[0].Action.push("s3:GetObject"),
      (p) => p.Statement[0].Resource.push("*"),
      (p) => {
        p.Statement[4].Resource = ["*"];
      },
      (p) => {
        p.Statement[4].Condition.StringEquals["kms:ViaService"] =
          "ec2.us-east-1.amazonaws.com";
      },
      (p) => {
        p.Statement[4].Condition.StringLike[
          "kms:EncryptionContext:aws:s3:arn"
        ] = ["arn:aws:s3:::other/*"];
      },
      (p) => {
        p.Statement[2].Resource[0] =
          "arn:aws:cloudfront::123456789012:distribution/EOTHER";
      },
      (p) => {
        p.Statement[0].Condition = {};
      },
    ]) {
      const p = sitePermissionsPlan(action),
        policy = sitePolicy();
      mutate(policy);
      resource(p).change.after.policy = JSON.stringify(policy);
      if (action === "no-op")
        resource(p).change.before.policy = resource(p).change.after.policy;
      expect(() => validate(p)).toThrow();
    }
  },
);
test("known policy and attachment identifiers must be exact", () => {
  const p = sitePermissionsPlan();
  for (const key of ["arn", "id"]) {
    resource(p).change.after[key] = policyArn;
    resource(p).change.after_unknown[key] = false;
  }
  resource(p, attachmentAddress).change.after.policy_arn = policyArn;
  resource(p, attachmentAddress).change.after_unknown.policy_arn = false;
  expect(() => validate(p)).not.toThrow();
  resource(p).change.after.arn = "arn:aws:iam::123456789012:policy/wrong";
  expect(() => validate(p)).toThrow();
});
test("KMS source contract keeps exact application key and both object contexts", () => {
  const source = readFileSync("_infra/site-publishing.tf", "utf8");
  const encryption = source.slice(
    source.indexOf('Sid      = "SiteObjectEncryption"'),
    source.indexOf("\n      }\n    ]"),
  );
  expect(encryption).toMatch(/Resource\s*= \[aws_kms_key.app_general.arn\]/);
  expect(encryption).toContain(
    'Action   = ["kms:GenerateDataKey", "kms:Decrypt"]',
  );
  expect(encryption).toContain(
    '"kms:CallerAccount" = data.aws_caller_identity.current.account_id',
  );
  expect(encryption).toContain(
    '"kms:ViaService"    = "s3.${var.aws_region}.amazonaws.com"',
  );
  expect(encryption).toContain(
    '["${aws_s3_bucket.frontend.arn}/*", "${aws_s3_bucket.docs.arn}/*"]',
  );
  const wrong = sitePermissionsPlan();
  resource(wrong, "aws_kms_key.app_general").change.after.arn =
    permissionBinding().kmsKeyArn.replace("11111111", "22222222");
  resource(wrong, "aws_kms_key.app_general").change.before = JSON.parse(
    JSON.stringify(resource(wrong, "aws_kms_key.app_general").change.after),
  );
  expect(() => validate(wrong)).toThrow();
});
test("binding reuses site selectors and pins storage and TFVAR agreement", () => {
  expect(
    sandboxSitePermissionsBinding(
      privateCaptureFixture().binding,
      siteVariables(),
    ),
  ).toEqual(permissionBinding());
  for (const [key, value] of [
    ["AWS_ACCOUNT_ID", "999999999999"],
    ["AWS_REGION", "eu-west-1"],
    ["DOCS_BUCKET", "bad/bucket"],
    ["FRONTEND_DISTRIBUTION_ID", "EOTHER"],
    ["TFVAR_docs_distribution_id", undefined],
    ["TFVAR_DOCS_DISTRIBUTION_ID", "ESYNTHETICDOCS"],
    [
      "SANDBOX_BACKEND_DEPLOY_ROLE_ARN",
      "arn:aws:iam::123456789012:role/custom-sandbox-github-deploy",
    ],
  ])
    expect(() =>
      sandboxSitePermissionsBinding(privateCaptureFixture().binding, {
        ...siteVariables(),
        [key]: value,
      }),
    ).toThrow();
  for (const vars of [null, [], "{}", { ...siteVariables(), DOCS_BUCKET: 1 }])
    expect(() =>
      sandboxSitePermissionsBinding(privateCaptureFixture().binding, vars),
    ).toThrow();
  expect(() =>
    validateSandboxSitePermissionsPlan(sitePermissionsPlan(), {
      ...permissionBinding(),
      environment: "production",
    }),
  ).toThrow();
});
test("Apply session intersects current writes with exact future grants within STS limit", () => {
  const prepared = prepareSandboxSitePermissionSession(permissionBinding());
  const policy = JSON.parse(prepared.policy);
  expect(policy).toEqual({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "*", Resource: "*" },
      { Effect: "Deny", Action: "dynamodb:UpdateTable", Resource: "*" },
      {
        Effect: "Deny",
        Action: [
          "iam:CreatePolicy",
          "iam:TagPolicy",
          "iam:CreatePolicyVersion",
        ],
        NotResource: policyArn,
      },
      {
        Effect: "Deny",
        Action: "iam:AttachRolePolicy",
        NotResource: permissionBinding().deploymentRoleArn,
      },
    ],
  });
  expect(prepared.masks).toContain(prepared.policy);
  expect(Buffer.byteLength(prepared.policy)).toBeLessThanOrEqual(2048);
  const longest = {
    ...permissionBinding(),
    frontendBucket: "a".repeat(63),
    docsBucket: "b".repeat(63),
    frontendDistributionId: "E" + "A".repeat(31),
    docsDistributionId: "E" + "B".repeat(31),
  };
  expect(
    Buffer.byteLength(prepareSandboxSitePermissionSession(longest).policy),
  ).toBeLessThanOrEqual(2048);
  // The inline allow does not grant anything absent from the bootstrap policy.
  const future = {
    Effect: "Allow",
    Action: "iam:AttachRolePolicy",
    Resource: permissionBinding().deploymentRoleArn,
    Condition: { StringEquals: { "iam:PolicyARN": policyArn } },
  };
  const current = JSON.parse(
    bootstrapPlan.resource_changes.find(
      (r) => r.address === "aws_iam_role_policy.sandbox_terraform[0]",
    ).change.after.policy,
  );
  expect(current.Statement).toContainEqual(expect.objectContaining(future));
  const baseStatements = current.Statement;
  const allowed = (action, arn, attached) => {
    const base = baseStatements.some(
      (s) =>
        s.Effect === "Allow" &&
        [s.Action].flat().includes(action) &&
        [s.Resource].flat().includes(arn) &&
        (!s.Condition?.StringEquals?.["iam:PolicyARN"] ||
          attached === s.Condition.StringEquals["iam:PolicyARN"]),
    );
    const denied = policy.Statement.filter((s) => s.Effect === "Deny").some(
      (s) =>
        [s.Action].flat().includes(action) &&
        (!s.NotResource || arn !== s.NotResource),
    );
    return base && !denied;
  };
  expect(
    current.Statement.find((s) => s.Sid === "HistoryDeliveryIndex").Action,
  ).toBe("dynamodb:UpdateTable");
  expect(
    allowed(
      "dynamodb:UpdateTable",
      "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable",
    ),
  ).toBe(false);
  expect(
    allowed(
      "iam:CreatePolicyVersion",
      "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-bot-dynamodb-policy",
    ),
  ).toBe(false);
  expect(allowed("iam:CreatePolicyVersion", policyArn)).toBe(true);
  expect(allowed("iam:CreatePolicy", policyArn)).toBe(true);
  expect(allowed("iam:TagPolicy", policyArn)).toBe(true);
  expect(allowed(future.Action, future.Resource, policyArn)).toBe(true);
  expect(allowed(future.Action, future.Resource, "other")).toBe(false);
  expect(allowed(future.Action, "other", policyArn)).toBe(false);
});
test("validator CLI refuses with a fixed diagnostic", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deployment/validate-sandbox-site-permissions-plan.cjs"],
    { input: "PRIVATE_BAD_PLAN", encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Sandbox site permissions refused\n");
});
test("session CLI masks before publishing and refuses malformed selectors without output", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-permissions-session-"));
  try {
    const output = join(dir, "output");
    const env = {
      ...process.env,
      TERRAFORM_PRIVATE_STORAGE_JSON: JSON.stringify(
        privateCaptureFixture().binding,
      ),
      GITHUB_VARS_JSON: JSON.stringify(siteVariables()),
      GITHUB_OUTPUT: output,
    };
    const prepared = prepareSandboxSitePermissionSession(permissionBinding());
    const result = spawnSync(
      process.execPath,
      [
        "scripts/deployment/validate-sandbox-site-permissions-plan.cjs",
        "--session",
      ],
      { env, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      prepared.masks.map((v) => `::add-mask::${v}\n`).join(""),
    );
    expect(readFileSync(output, "utf8")).toBe(`policy=${prepared.policy}\n`);
    rmSync(output);
    const refused = spawnSync(
      process.execPath,
      [
        "scripts/deployment/validate-sandbox-site-permissions-plan.cjs",
        "--session",
      ],
      { env: { ...env, GITHUB_VARS_JSON: "[]" }, encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe("Sandbox site permissions refused\n");
    expect(() => readFileSync(output)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Sandbox role keeps exact HTTPS input guard without ALB or OIDC-list dependency", () => {
  const role = readFileSync("_infra/sandbox-deployment.tf", "utf8");
  const listener = readFileSync("_infra/api.tf", "utf8");
  const predicate = listener.match(
    /resource "aws_lb_listener" "api_https" \{\s+count\s+= (.+) \? 1 : 0/,
  )[1];
  const condition = role.match(/condition\s+= (.+)/)[1];
  expect(condition).toBe(
    `var.github_environment == "sandbox" && (${predicate})`,
  );
  expect(
    role.slice(0, role.indexOf('resource "aws_iam_role_policy"')),
  ).not.toMatch(/aws_lb_listener|aws_lb\.|aws_vpc/);
  expect(
    role.match(
      /data "aws_iam_openid_connect_provider" "github_deploy" \{([^}]+(?:}[^}]+)?)/,
    )[0],
  ).toContain(
    'arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"',
  );
});

// Evaluate the condition operators present in the reviewed base/session documents.
const policyMatches = (pattern, value) =>
  new RegExp(
    "^" +
      pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  ).test(value);
const conditionMatches = (condition, context) =>
  Object.entries(condition ?? {}).every(([operator, fields]) => {
    expect([
      "StringEquals",
      "StringLike",
      "ForAllValues:StringEquals",
    ]).toContain(operator);
    return Object.entries(fields).every(([key, expected]) => {
      if (!Object.hasOwn(context, key)) return false;
      const wanted = [expected].flat(),
        actual = [context[key]].flat();
      const matches = (value) =>
        wanted.some((v) =>
          operator === "StringLike" ? policyMatches(v, value) : v === value,
        );
      return operator === "ForAllValues:StringEquals"
        ? actual.every(matches)
        : actual.some(matches);
    });
  });
function policyAllows(policy, action, resource, context) {
  const applies = (s) =>
    [s.Action].flat().some((a) => policyMatches(a, action)) &&
    (s.NotResource
      ? ![s.NotResource].flat().some((r) => policyMatches(r, resource))
      : [s.Resource].flat().some((r) => policyMatches(r, resource))) &&
    conditionMatches(s.Condition, context);
  return (
    policy.Statement.some((s) => s.Effect === "Allow" && applies(s)) &&
    !policy.Statement.some((s) => s.Effect === "Deny" && applies(s))
  );
}
test("completed base policy has exactly the reviewed write inventory and effective operations", () => {
  const base = JSON.parse(
    resource(bootstrapPlan, "aws_iam_role_policy.sandbox_terraform[0]").change
      .after.policy,
  );
  const session = JSON.parse(
    prepareSandboxSitePermissionSession(permissionBinding()).policy,
  );
  const state =
    "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state";
  const locks =
    "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-terraform-state-locks";
  const capture =
    "arn:aws:s3:::meeting-notes-sandbox-private-evidence-123456789012/terraform/sandbox/*";
  const key = permissionBinding().kmsKeyArn;
  const history =
    "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable";
  const runtime =
    "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-bot-dynamodb-policy";
  const deploymentRole = permissionBinding().deploymentRoleArn;
  const context = {
    "iam:PolicyARN": policyArn,
    "dynamodb:LeadingKeys": [state.slice("arn:aws:s3:::".length)],
    "s3:if-none-match": "*",
    "s3:x-amz-server-side-encryption": "aws:kms",
    "s3:x-amz-server-side-encryption-aws-kms-key-id": key,
    "kms:CallerAccount": "123456789012",
    "kms:ViaService": "s3.us-east-1.amazonaws.com",
    "kms:EncryptionContext:aws:s3:arn": capture.replace("*", "run/plan"),
  };
  const reads = new Set([
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetBucketVersioning",
    "s3:GetBucketOwnershipControls",
    "s3:GetBucketPublicAccessBlock",
    "s3:GetBucketPolicyStatus",
    "s3:GetBucketPolicy",
    "s3:GetEncryptionConfiguration",
    "s3:GetLifecycleConfiguration",
    "s3:GetBucketAcl",
    "s3:GetBucketCORS",
    "s3:GetBucketWebsite",
    "s3:GetAccelerateConfiguration",
    "s3:GetBucketRequestPayment",
    "s3:GetBucketLogging",
    "s3:GetReplicationConfiguration",
    "s3:GetBucketObjectLockConfiguration",
    "s3:GetBucketTagging",
    "dynamodb:GetItem",
    "dynamodb:DescribeTable",
    "dynamodb:DescribeContinuousBackups",
    "dynamodb:DescribeTimeToLive",
    "dynamodb:ListTagsOfResource",
    "iam:GetPolicy",
    "iam:GetPolicyVersion",
    "iam:ListPolicyTags",
    "iam:ListPolicyVersions",
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListRolePolicies",
    "iam:ListAttachedRolePolicies",
    "iam:GetOpenIDConnectProvider",
    "kms:DescribeKey",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListResourceTags",
  ]);
  const writes = base.Statement.map((s) => ({
    ...s,
    Action: [s.Action].flat().filter((a) => !reads.has(a)),
  })).filter((s) => s.Action.length);
  const grant = (Sid, Action, Resource, Condition) => ({
    Sid,
    Effect: "Allow",
    Action,
    Resource,
    ...(Condition ? { Condition } : {}),
  });
  expect(writes).toEqual([
    grant(
      "SitePolicy",
      ["iam:CreatePolicy", "iam:TagPolicy", "iam:CreatePolicyVersion"],
      policyArn,
    ),
    grant("SiteAttachment", ["iam:AttachRolePolicy"], deploymentRole, {
      StringEquals: { "iam:PolicyARN": policyArn },
    }),
    grant("ApplicationState", ["s3:PutObject"], state),
    grant(
      "SandboxStateLocks",
      ["dynamodb:PutItem", "dynamodb:DeleteItem"],
      locks,
      {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": [
            state.slice("arn:aws:s3:::".length),
            state.slice("arn:aws:s3:::".length) + "-md5",
          ],
        },
      },
    ),
    grant("HistoryDeliveryIndex", ["dynamodb:UpdateTable"], history),
    grant("RuntimePolicyVersion", ["iam:CreatePolicyVersion"], runtime),
    grant("ConditionalCapture", ["s3:PutObject"], capture, {
      StringEquals: {
        "s3:if-none-match": "*",
        "s3:x-amz-server-side-encryption": "aws:kms",
        "s3:x-amz-server-side-encryption-aws-kms-key-id": key,
      },
    }),
    grant("CaptureKeyUse", ["kms:GenerateDataKey", "kms:Decrypt"], key, {
      StringEquals: {
        "kms:CallerAccount": "123456789012",
        "kms:ViaService": "s3.us-east-1.amazonaws.com",
      },
      StringLike: { "kms:EncryptionContext:aws:s3:arn": capture },
    }),
  ]);
  const effective = (action, arn, ctx = context) =>
    policyAllows(base, action, arn, ctx) &&
    policyAllows(session, action, arn, ctx);
  for (const [action, arn, allowed] of [
    ["s3:PutObject", state, true],
    ["s3:GetObject", state, true],
    ["dynamodb:PutItem", locks, true],
    ["dynamodb:DeleteItem", locks, true],
    ["s3:PutObject", capture.replace("*", "run/plan"), true],
    ["s3:GetObjectVersion", capture.replace("*", "run/plan"), true],
    ["kms:GenerateDataKey", key, true],
    ["kms:Decrypt", key, true],
    ["iam:CreatePolicy", policyArn, true],
    ["iam:TagPolicy", policyArn, true],
    ["iam:CreatePolicyVersion", policyArn, true],
    ["iam:AttachRolePolicy", deploymentRole, true],
    ["iam:CreatePolicyVersion", runtime, false],
    ["dynamodb:UpdateTable", history, false],
    ["dynamodb:PutItem", history, false],
    ["iam:AttachRolePolicy", deploymentRole.replace("sandbox", "prod"), false],
    ["iam:DeletePolicyVersion", policyArn, false],
    ["iam:DetachRolePolicy", deploymentRole, false],
    [
      "s3:PutObject",
      "arn:aws:s3:::" + permissionBinding().frontendBucket + "/file",
      false,
    ],
    [
      "s3:PutObject",
      capture.replace("sandbox/", "prod/").replace("*", "run/plan"),
      false,
    ],
  ])
    expect(effective(action, arn)).toBe(allowed);
  expect(
    effective("iam:AttachRolePolicy", deploymentRole, {
      ...context,
      "iam:PolicyARN": runtime,
    }),
  ).toBe(false);
  expect(
    effective("dynamodb:PutItem", locks, {
      ...context,
      "dynamodb:LeadingKeys": ["other"],
    }),
  ).toBe(false);
  expect(
    effective("s3:PutObject", capture.replace("*", "run/plan"), {
      ...context,
      "s3:if-none-match": "other",
    }),
  ).toBe(false);
  expect(
    effective("kms:Decrypt", key, {
      ...context,
      "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::other/file",
    }),
  ).toBe(false);
  expect(
    policyAllows(
      {
        Statement: [
          {
            Effect: "Deny",
            Action: "iam:AttachRolePolicy",
            Resource: deploymentRole,
          },
        ],
      },
      "iam:AttachRolePolicy",
      deploymentRole,
      context,
    ),
  ).toBe(false);
});

test("Production role retains the listener count predicate without pulling routing into Sandbox targets", () => {
  const role = readFileSync("_infra/production-deployment.tf", "utf8");
  const listener = readFileSync("_infra/api.tf", "utf8");
  const predicate = listener.match(
    /resource "aws_lb_listener" "api_https" \{\s+count\s+= (.+) \? 1 : 0/,
  )[1];
  const condition = role.match(/condition\s+= (.+)/)[1];
  expect(condition).toBe(
    `var.github_environment == "production" && (${predicate})`,
  );
});
