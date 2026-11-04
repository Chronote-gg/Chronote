"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  readFileSync,
  createReadStream,
  mkdtempSync,
  writeFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  validateBootstrapSitePermissionsUpdate: inspect,
} = require("./verify-plan.cjs");
const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, "tests/fixtures", name), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
function candidate(noop = false) {
  const plan = fixture("create-plan.json");
  const binding = fixture("reviewed-binding.json");
  const previous = fixture("previous-role-policy.json");
  assert.equal(hash(previous.policy), previous.sha256);
  for (const r of plan.resource_changes) {
    r.change.before = structuredClone(r.change.after);
    r.change.actions = ["no-op"];
    r.change.after_unknown = {};
  }
  const policy = plan.resource_changes.find(
    (r) => r.type === "aws_iam_role_policy",
  );
  if (!noop) {
    policy.change.before.policy = previous.policy;
    policy.change.actions = ["update"];
  }
  binding.bucketOwnerCanonicalId = "a".repeat(64);
  binding.previousRolePolicySha256 = noop
    ? hash(policy.change.before.policy)
    : previous.sha256;
  plan.applyable = !noop;
  return { plan, binding, policy };
}
test("accepts only the reviewed runner policy update and a fully checked no-op", () => {
  for (const noop of [false, true]) {
    const c = candidate(noop);
    assert.equal(inspect(c.plan, c.binding), true);
  }
});
test("refuses a synthetic complete envelope missing dedicated storage resources", () => {
  const c = candidate();
  c.plan.resource_changes = c.plan.resource_changes.filter((r) =>
    [
      "aws_iam_role",
      "aws_iam_role_policy",
      "aws_iam_openid_connect_provider",
    ].includes(r.type),
  );
  assert.throws(
    () => inspect(c.plan, c.binding),
    /missing reviewed bootstrap resource/,
  );
});
const entry = (c, type) => c.plan.resource_changes.find((r) => r.type === type);
const config = (c, type) =>
  c.plan.configuration.root_module.resources.find((r) => r.type === type);
function nativeCandidate(noop = false) {
  const c = candidate(noop);
  const bucket = entry(c, "aws_s3_bucket");
  Object.assign(bucket.change.after, fixture("native-readback.json"));
  bucket.change.after.policy = entry(
    c,
    "aws_s3_bucket_policy",
  ).change.after.policy;
  bucket.change.before = structuredClone(bucket.change.after);
  const role = entry(c, "aws_iam_role");
  role.change.after.permissions_boundary = "";
  role.change.after.inline_policy = [
    {
      name: c.policy.change.after.name,
      policy: c.policy.change.before.policy,
    },
  ];
  role.change.before = structuredClone(role.change.after);
  const encryption = entry(
    c,
    "aws_s3_bucket_server_side_encryption_configuration",
  );
  encryption.change.after.expected_bucket_owner = "";
  encryption.change.after.rule[0].blocked_encryption_types = ["SSE-C"];
  encryption.change.before = structuredClone(encryption.change.after);
  const versioning = entry(c, "aws_s3_bucket_versioning");
  versioning.change.after.expected_bucket_owner = "";
  versioning.change.after.versioning_configuration[0].mfa_delete = "Disabled";
  versioning.change.before = structuredClone(versioning.change.after);
  return c;
}
test("accepts native unchanged readback for policy update and no-op", () => {
  for (const noop of [false, true]) {
    const c = nativeCandidate(noop);
    assert.equal(inspect(c.plan, c.binding), true);
  }
});
for (const type of [
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_versioning",
]) {
  test(`accepts the configured account owner for ${type}`, () => {
    const c = nativeCandidate();
    for (const expression of [
      { references: ["var.sandbox_account_id"] },
      { constant_value: c.binding.variables.sandbox_account_id },
      { constant_value: null },
    ]) {
      config(c, type).expressions.expected_bucket_owner = expression;
      const { before, after } = entry(c, type).change;
      before.expected_bucket_owner = after.expected_bucket_owner =
        expression.constant_value === null
          ? null
          : c.binding.variables.sandbox_account_id;
      assert.equal(inspect(c.plan, c.binding), true);
    }
  });
  for (const [label, alter] of [
    [
      "configured account",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = {
          constant_value: c.binding.variables.sandbox_account_id,
        };
      },
    ],
    [
      "configured account reference",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = {
          references: ["var.sandbox_account_id"],
        };
      },
    ],
    [
      "configured empty",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = {
          constant_value: "",
        };
      },
    ],
    [
      "configured wrong expression",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = {
          references: ["var.github_owner_id"],
        };
      },
    ],
    [
      "configured null",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = {
          constant_value: null,
        };
      },
    ],
    [
      "explicit null expression",
      (c) => {
        config(c, type).expressions.expected_bucket_owner = null;
      },
    ],
    [
      "unknown owner",
      (c) => {
        entry(c, type).change.after_unknown.expected_bucket_owner = true;
      },
    ],
    [
      "foreign owner",
      (c) => {
        const { before, after } = entry(c, type).change;
        before.expected_bucket_owner = after.expected_bucket_owner =
          "999999999999";
      },
    ],
    [
      "changed owner",
      (c) => {
        entry(c, type).change.before.expected_bucket_owner = null;
      },
    ],
    [
      "changed owner to configured account",
      (c) => {
        entry(c, type).change.after.expected_bucket_owner =
          c.binding.variables.sandbox_account_id;
      },
    ],
    [
      "missing prior owner",
      (c) => {
        delete entry(c, type).change.before.expected_bucket_owner;
      },
    ],
    [
      "missing independent owner binding",
      (c) => {
        delete c.binding.bucketOwnerCanonicalId;
      },
    ],
    [
      "update action",
      (c) => {
        entry(c, type).change.actions = ["update"];
      },
    ],
    [
      "replacement action",
      (c) => {
        entry(c, type).change.actions = ["delete", "create"];
      },
    ],
  ])
    test(`empty owner for ${type} refuses ${label}`, () => {
      const c = nativeCandidate();
      alter(c);
      assert.throws(() => inspect(c.plan, c.binding));
    });
  test(`cold-create refuses empty owner for ${type}`, () => {
    const plan = fixture("create-plan.json");
    const binding = fixture("reviewed-binding.json");
    entry({ plan }, type).change.after.expected_bucket_owner = "";
    assert.throws(() =>
      require("./verify-plan.cjs").validateBootstrapPlan(plan, binding),
    );
  });
}
for (const type of [
  "aws_s3_bucket",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_policy",
  "aws_iam_role",
  "aws_iam_role_policy",
  "aws_caller_identity",
  "aws_kms_key",
  "aws_iam_openid_connect_provider",
])
  test(`refuses unchanged empty owner on other resource ${type}`, () => {
    const c = candidate();
    const { before, after } = entry(c, type).change;
    before.expected_bucket_owner = after.expected_bucket_owner = "";
    assert.throws(() => inspect(c.plan, c.binding));
  });
test("compares the observed bucket policy semantically and accepts null boundary", () => {
  const c = nativeCandidate();
  const bucket = entry(c, "aws_s3_bucket");
  bucket.change.after.policy = JSON.stringify(
    JSON.parse(bucket.change.after.policy),
    null,
    2,
  );
  bucket.change.before = structuredClone(bucket.change.after);
  const role = entry(c, "aws_iam_role");
  role.change.before.permissions_boundary =
    role.change.after.permissions_boundary = null;
  assert.equal(inspect(c.plan, c.binding), true);
});
for (const [label, alter] of [
  ["missing owner binding", (c) => delete c.binding.bucketOwnerCanonicalId],
  [
    "invalid owner binding",
    (c) => (c.binding.bucketOwnerCanonicalId = "owner"),
  ],
  [
    "wrong owner",
    (c) =>
      (entry(c, "aws_s3_bucket").change.after.grant[0].id = "b".repeat(64)),
  ],
  [
    "extra owner grant",
    (c) =>
      entry(c, "aws_s3_bucket").change.after.grant.push(
        structuredClone(entry(c, "aws_s3_bucket").change.after.grant[0]),
      ),
  ],
  [
    "public grant",
    (c) =>
      Object.assign(entry(c, "aws_s3_bucket").change.after.grant[0], {
        type: "Group",
        uri: "http://acs.amazonaws.com/groups/global/AllUsers",
      }),
  ],
  [
    "extra grant permission",
    (c) =>
      entry(c, "aws_s3_bucket").change.after.grant[0].permissions.push("READ"),
  ],
  [
    "configured ACL",
    (c) =>
      (config(c, "aws_s3_bucket").expressions.acl = {
        constant_value: "private",
      }),
  ],
  [
    "configured grant",
    (c) => (config(c, "aws_s3_bucket").expressions.grant = {}),
  ],
  [
    "configured policy",
    (c) => (config(c, "aws_s3_bucket").expressions.policy = {}),
  ],
  [
    "configured encryption",
    (c) =>
      (config(
        c,
        "aws_s3_bucket",
      ).expressions.server_side_encryption_configuration = {}),
  ],
  [
    "configured versioning",
    (c) => (config(c, "aws_s3_bucket").expressions.versioning = {}),
  ],
  [
    "foreign boundary",
    (c) =>
      (entry(c, "aws_iam_role").change.after.permissions_boundary =
        "arn:aws:iam::123456789012:policy/foreign"),
  ],
  [
    "configured empty boundary",
    (c) =>
      (config(c, "aws_iam_role").expressions.permissions_boundary = {
        constant_value: "",
      }),
  ],
  [
    "second inline policy",
    (c) =>
      entry(c, "aws_iam_role").change.after.inline_policy.push({
        name: "extra",
        policy: "{}",
      }),
  ],
  [
    "changed inline shadow",
    (c) =>
      (entry(c, "aws_iam_role").change.after.inline_policy[0].policy += " "),
  ],
  [
    "configured inline policy",
    (c) => (config(c, "aws_iam_role").expressions.inline_policy = {}),
  ],
  [
    "changed shadow policy",
    (c) => (entry(c, "aws_s3_bucket").change.after.policy = "{}"),
  ],
  [
    "changed dedicated policy",
    (c) => (entry(c, "aws_s3_bucket_policy").change.after.policy = "{}"),
  ],
  ["drift", (c) => (c.plan.resource_drift = [{}])],
  ["incomplete", (c) => (c.plan.complete = false)],
  ...[
    "grant",
    "policy",
    "server_side_encryption_configuration",
    "versioning",
  ].map((field) => [
    "unknown " + field,
    (c) => (entry(c, "aws_s3_bucket").change.after_unknown[field] = true),
  ]),
  [
    "unknown boundary",
    (c) =>
      (entry(c, "aws_iam_role").change.after_unknown.permissions_boundary =
        true),
  ],
  [
    "unknown embedded field",
    (c) => (entry(c, "aws_s3_bucket").change.after.versioning[0].extra = false),
  ],
  [
    "wrong shadow key",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket",
      ).change.after.server_side_encryption_configuration[0].rule[0].apply_server_side_encryption_by_default[0].kms_master_key_id =
        "foreign"),
  ],
  [
    "wrong shadow algorithm",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket",
      ).change.after.server_side_encryption_configuration[0].rule[0].apply_server_side_encryption_by_default[0].sse_algorithm =
        "AES256"),
  ],
  [
    "shadow bucket key",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket",
      ).change.after.server_side_encryption_configuration[0].rule[0].bucket_key_enabled =
        true),
  ],
  [
    "shadow suspended versioning",
    (c) =>
      (entry(c, "aws_s3_bucket").change.after.versioning[0].enabled = false),
  ],
  [
    "shadow MFA delete",
    (c) =>
      (entry(c, "aws_s3_bucket").change.after.versioning[0].mfa_delete = true),
  ],
  [
    "dedicated bucket key",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket_server_side_encryption_configuration",
      ).change.after.rule[0].bucket_key_enabled = true),
  ],
  [
    "dedicated versioning",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket_versioning",
      ).change.after.versioning_configuration[0].status = "Suspended"),
  ],
  [
    "dedicated MFA delete",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket_versioning",
      ).change.after.versioning_configuration[0].mfa_delete = "Enabled"),
  ],
  [
    "dedicated SSE-C restriction",
    (c) =>
      (entry(
        c,
        "aws_s3_bucket_server_side_encryption_configuration",
      ).change.after.rule[0].blocked_encryption_types = ["aws:kms"]),
  ],
])
  test(`native readback refuses ${label}`, () => {
    const c = nativeCandidate();
    alter(c);
    // Preserve no-op byte equality so semantic validation, not a changed-field check, refuses.
    for (const r of c.plan.resource_changes.filter(
      (r) => r.change.actions[0] === "no-op",
    ))
      r.change.before = structuredClone(r.change.after);
    assert.throws(() => inspect(c.plan, c.binding));
  });
test("cold-create rejects owner metadata and native embedded controls", () => {
  const { validateBootstrapPlan } = require("./verify-plan.cjs");
  const plan = fixture("create-plan.json"),
    binding = fixture("reviewed-binding.json");
  binding.bucketOwnerCanonicalId = "a".repeat(64);
  assert.throws(() => validateBootstrapPlan(plan, binding));
  delete binding.bucketOwnerCanonicalId;
  Object.assign(
    plan.resource_changes.find((r) => r.type === "aws_s3_bucket").change.after,
    fixture("native-readback.json"),
  );
  assert.throws(() => validateBootstrapPlan(plan, binding));
});
for (const [label, alter] of [
  [
    "wrong previous hash",
    (c) => (c.binding.previousRolePolicySha256 = "0".repeat(64)),
  ],
  ["missing previous hash", (c) => delete c.binding.previousRolePolicySha256],
  ["unknown binding field", (c) => (c.binding.allow = true)],
  [
    "unknown policy hash field",
    (c) => (c.binding.policySha256.extra = "0".repeat(64)),
  ],
  ["wrong backend", (c) => (c.binding.backendKey = "application/state")],
  [
    "missing bucket input",
    (c) => {
      delete c.binding.variables.site_docs_bucket;
      delete c.plan.variables.site_docs_bucket;
    },
  ],
  [
    "mismatched bucket input",
    (c) =>
      (c.plan.variables.site_frontend_bucket = { value: "another-bucket" }),
  ],
  [
    "unknown input",
    (c) => {
      c.binding.variables.extra = true;
      c.plan.variables.extra = { value: true };
    },
  ],
  [
    "wrong reviewed site",
    (c) => {
      c.binding.variables.site_frontend_bucket = "another-bucket";
      c.plan.variables.site_frontend_bucket = { value: "another-bucket" };
    },
  ],
  [
    "invalid site bucket",
    (c) => {
      c.binding.variables.site_docs_bucket = "*";
      c.plan.variables.site_docs_bucket = { value: "*" };
    },
  ],
  [
    "missing target",
    (c) =>
      (c.plan.resource_changes = c.plan.resource_changes.filter(
        (r) => r !== c.policy,
      )),
  ],
  ["before policy drift", (c) => (c.policy.change.before.policy += " ")],
  ["after policy drift", (c) => (c.policy.change.after.policy += " ")],
  [
    "unreviewed hashed policy",
    (c) => {
      c.policy.change.after.policy = JSON.stringify({
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      });
      c.binding.policySha256.role = hash(c.policy.change.after.policy);
    },
  ],
  [
    "unrelated policy attribute",
    (c) => (c.policy.change.after.name = "another-policy"),
  ],
  [
    "unknown policy value",
    (c) => (c.policy.change.after_unknown.policy = true),
  ],
  ["unknown unrelated value", (c) => (c.policy.change.after_unknown.id = true)],
  ["import", (c) => (c.policy.change.importing = { id: "existing" })],
  ["move", (c) => (c.policy.previous_address = "old.policy[0]")],
  ["drift", (c) => (c.plan.resource_drift = [{}])],
  ["deferred work", (c) => (c.plan.deferred_changes = [{}])],
  ["incomplete plan", (c) => (c.plan.complete = false)],
  ["failed check", (c) => (c.plan.checks = [{ status: "fail" }])],
  [
    "trust update",
    (c) => (entry(c, "aws_iam_role").change.actions = ["update"]),
  ],
  [
    "no-op trust drift",
    (c) => {
      const r = entry(c, "aws_iam_role");
      r.change.after.assume_role_policy = r.change.before.assume_role_policy =
        "{}";
    },
  ],
  [
    "bucket update",
    (c) => (entry(c, "aws_s3_bucket").change.actions = ["update"]),
  ],
  [
    "no-op storage drift",
    (c) => {
      const r = entry(c, "aws_s3_bucket");
      r.change.after.bucket = r.change.before.bucket = "other-bucket";
    },
  ],
  [
    "key change",
    (c) => (entry(c, "aws_kms_key").change.after.arn = "another-key"),
  ],
  [
    "provider change",
    (c) =>
      (config(c, "aws_iam_role_policy").provider_config_key = "aws.foreign"),
  ],
  [
    "unrelated resource",
    (c) =>
      c.plan.resource_changes.push({
        ...c.policy,
        address: "aws_iam_policy.admin[0]",
        type: "aws_iam_policy",
      }),
  ],
  ["duplicate", (c) => c.plan.resource_changes.push(c.policy)],
  [
    "no-op conceals changed bytes",
    (c) => {
      c.policy.change.actions = ["no-op"];
    },
  ],
  ["update marked nonapplyable", (c) => (c.plan.applyable = false)],
])
  test(`site update refuses ${label}`, () => {
    const c = candidate();
    alter(c);
    assert.throws(() => inspect(c.plan, c.binding));
  });
for (const actions of [["create"], ["delete"], ["delete", "create"], ["read"]])
  test(`site update refuses target effects ${actions}`, () => {
    const c = candidate();
    c.policy.change.actions = actions;
    assert.throws(() => inspect(c.plan, c.binding));
  });
test("CLI refuses unknown modes and the cold guard refuses update bindings", () => {
  const c = candidate();
  assert.throws(() =>
    require("./verify-plan.cjs").validateBootstrapPlan(c.plan, c.binding),
  );
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "verify-plan.cjs"), "unused", "unused", "--unknown"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage/);
});
test("runner site grants are exact and the inline policy fits IAM", () => {
  const c = candidate();
  const statements = JSON.parse(c.policy.change.after.policy).Statement;
  const site = statements.find((s) => s.Sid === "SitePolicy");
  assert.deepEqual(site, {
    Sid: "SitePolicy",
    Effect: "Allow",
    Action: [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:CreatePolicy",
      "iam:TagPolicy",
      "iam:CreatePolicyVersion",
    ],
    Resource:
      "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-site-publishing",
  });
  assert.deepEqual(
    statements.find((s) => s.Sid === "SiteAttachment"),
    {
      Sid: "SiteAttachment",
      Effect: "Allow",
      Action: "iam:AttachRolePolicy",
      Resource:
        "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy",
      Condition: { StringEquals: { "iam:PolicyARN": site.Resource } },
    },
  );
  assert.ok(Buffer.byteLength(c.policy.change.after.policy) <= 10240);
  const prohibited = [
    "iam:DeletePolicyVersion",
    "iam:DetachRolePolicy",
    "iam:DeletePolicy",
    "iam:UpdateAssumeRolePolicy",
    "iam:PutRolePolicy",
    "iam:UntagPolicy",
    "iam:SetDefaultPolicyVersion",
    "dynamodb:Scan",
    "dynamodb:Query",
    "s3:DeleteObject",
  ];
  assert.equal(
    statements.some((s) =>
      [s.Action].flat().some((a) => prohibited.includes(a) || a.includes("*")),
    ),
    false,
  );
});

test("validates provider-refreshed inline policy on the unchanged runner role", () => {
  const c = candidate();
  const role = entry(c, "aws_iam_role");
  const inline = [
    { name: c.policy.change.after.name, policy: c.policy.change.before.policy },
  ];
  role.change.before.inline_policy = role.change.after.inline_policy = inline;
  assert.equal(inspect(c.plan, c.binding), true);
  inline[0].policy += " ";
  assert.throws(() => inspect(c.plan, c.binding));
});

test(
  "native application target graph contains only exact site resources and known metadata",
  { skip: !process.env.SANDBOX_SITE_MOCK_PLAN_JSONL },
  async () => {
    const lines = require("node:readline").createInterface({
      input: createReadStream(process.env.SANDBOX_SITE_MOCK_PLAN_JSONL),
    });
    let resources, summary;
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === "test_summary") summary = event.test_summary.status;
      if (
        event.type === "test_plan" &&
        event["@testrun"] === "sandbox_site_policy"
      )
        resources = event.test_plan.resource_changes;
    }
    assert.equal(summary, "pass");
    const plan = { resource_changes: resources };
    assert.deepEqual(
      plan.resource_changes
        .filter((r) => r.mode === "managed")
        .map((r) => r.address)
        .sort(),
      [
        "aws_iam_policy.site_publishing[0]",
        "aws_iam_role.sandbox_deploy[0]",
        "aws_iam_role_policy_attachment.site_publishing[0]",
        "aws_kms_key.app_general",
        "aws_s3_bucket.docs",
        "aws_s3_bucket.frontend",
      ],
    );
    const metadata = [
      "data.aws_caller_identity.current",
      "data.aws_iam_openid_connect_provider.github_deploy[0]",
      "data.github_organization.deployment_owner[0]",
      "data.github_repository.repo",
    ];
    for (const r of plan.resource_changes.filter((r) => r.mode === "data"))
      assert.ok(metadata.includes(r.address), r.address);
  },
);

test("CLI accepts reviewed cold-create and bounded-update documents", () => {
  const directory = mkdtempSync(join(tmpdir(), "sandbox-bootstrap-guard-"));
  try {
    for (const update of [false, true]) {
      const c = update
        ? nativeCandidate()
        : {
            plan: fixture("create-plan.json"),
            binding: fixture("reviewed-binding.json"),
          };
      const planPath = join(directory, "plan.json"),
        bindingPath = join(directory, "binding.json");
      writeFileSync(planPath, JSON.stringify(c.plan));
      writeFileSync(bindingPath, JSON.stringify(c.binding));
      const result = spawnSync(
        process.execPath,
        [
          join(__dirname, "verify-plan.cjs"),
          planPath,
          bindingPath,
          ...(update ? ["--site-permissions-update"] : []),
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
