"use strict";
const check = require("node:assert/strict");
const { test: scenario } = require("node:test");
const { readFileSync, createReadStream } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { load } = require("js-yaml");
const guardPath = join(__dirname, "verify-plan.cjs");
check.ok(
  require("node:fs").existsSync(guardPath),
  "Sandbox bootstrap guard is missing",
);
const { validateBootstrapPlan: inspect } = require(guardPath);
const { compactMockPlan: compact } = require("./compact-mock-plan.cjs");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureDirectory = join(__dirname, "tests/fixtures");
function candidate() {
  return {
    document: JSON.parse(
      readFileSync(join(fixtureDirectory, "create-plan.json")),
    ),
    review: JSON.parse(
      readFileSync(join(fixtureDirectory, "reviewed-binding.json")),
    ),
  };
}
const resource = (c, kind) =>
  c.document.resource_changes.find((change) => change.type === kind);
const control = (c, kind) => resource(c, kind).change.after;
const configured = (c, kind) =>
  c.document.configuration.root_module.resources.find(
    (item) => item.type === kind,
  );
function refuse(name, alter) {
  scenario(name, () => {
    const trial = candidate();
    alter(trial);
    check.throws(() => inspect(trial.document, trial.review));
  });
}
scenario("accepts the independently reviewed synthetic create contract", () => {
  const trial = candidate();
  check.equal(inspect(trial.document, trial.review), true);
});
for (const verb of [["update"], ["delete"], ["delete", "create"], ["no-op"]])
  refuse(
    `refuses managed effects ${verb}`,
    (c) => (resource(c, "aws_s3_bucket").change.actions = verb),
  );
for (const field of [
  "deferred_changes",
  "resource_drift",
  "action_invocations",
  "ephemeral_resource_changes",
])
  refuse(`refuses pending work in ${field}`, (c) => (c.document[field] = [{}]));
for (const field of ["complete", "applyable", "errored"])
  refuse(
    `refuses untrusted envelope flag ${field}`,
    (c) => (c.document[field] = !c.document[field]),
  );
for (const [label, alter] of [
  [
    "import",
    (c) => (resource(c, "aws_s3_bucket").change.importing = { id: "foreign" }),
  ],
  [
    "move",
    (c) => (resource(c, "aws_s3_bucket").previous_address = "old.bucket"),
  ],
  [
    "foreign provider",
    (c) =>
      (resource(c, "aws_s3_bucket").provider_name =
        "registry.example.test/foreign/aws"),
  ],
  [
    "foreign provider alias",
    (c) => (configured(c, "aws_s3_bucket").provider_config_key = "aws.foreign"),
  ],
  [
    "unexpected attachment",
    (c) =>
      c.document.resource_changes.push({
        ...resource(c, "aws_iam_role"),
        type: "aws_iam_role_policy_attachment",
        address: "aws_iam_role_policy_attachment.admin[0]",
      }),
  ],
  [
    "extra key",
    (c) =>
      c.document.resource_changes.push({
        ...resource(c, "aws_s3_bucket"),
        type: "aws_kms_key",
        address: "aws_kms_key.extra[0]",
      }),
  ],
  [
    "missing create",
    (c) =>
      (c.document.resource_changes = c.document.resource_changes.filter(
        (r) => r.type !== "aws_iam_role_policy",
      )),
  ],
  [
    "duplicate create",
    (c) => c.document.resource_changes.push(resource(c, "aws_s3_bucket")),
  ],
  [
    "missing configuration",
    (c) => (c.document.configuration.root_module.resources = []),
  ],
  [
    "foreign child module",
    (c) => (c.document.configuration.root_module.child_modules = [{}]),
  ],
  ["wrong instance index", (c) => (resource(c, "aws_iam_role").index = 1)],
  [
    "wrong resource name",
    (c) => (resource(c, "aws_iam_role").name = "administrator"),
  ],
  [
    "forced bucket deletion",
    (c) => (control(c, "aws_s3_bucket").force_destroy = true),
  ],
  ["public ACL", (c) => (control(c, "aws_s3_bucket").acl = "public-read")],
  [
    "expiration",
    (c) =>
      (control(c, "aws_s3_bucket").lifecycle_rule = [
        { expiration: [{ days: 1 }] },
      ]),
  ],
  [
    "suspended versioning",
    (c) =>
      (control(
        c,
        "aws_s3_bucket_versioning",
      ).versioning_configuration[0].status = "Suspended"),
  ],
  [
    "wrong ownership",
    (c) =>
      (control(c, "aws_s3_bucket_ownership_controls").rule[0].object_ownership =
        "ObjectWriter"),
  ],
  [
    "bucket keys",
    (c) =>
      (control(
        c,
        "aws_s3_bucket_server_side_encryption_configuration",
      ).rule[0].bucket_key_enabled = true),
  ],
  [
    "wrong encryption key",
    (c) =>
      (control(
        c,
        "aws_s3_bucket_server_side_encryption_configuration",
      ).rule[0].apply_server_side_encryption_by_default[0].kms_master_key_id =
        "foreign"),
  ],
  [
    "extra encryption rule",
    (c) =>
      control(
        c,
        "aws_s3_bucket_server_side_encryption_configuration",
      ).rule.push({}),
  ],
  [
    "object lock",
    (c) => (control(c, "aws_s3_bucket").object_lock_enabled = true),
  ],
  ["role path", (c) => (control(c, "aws_iam_role").path = "/foreign/")],
  [
    "session duration",
    (c) => (control(c, "aws_iam_role").max_session_duration = 43200),
  ],
  [
    "permission boundary",
    (c) => (control(c, "aws_iam_role").permissions_boundary = "admin"),
  ],
  [
    "force detachment",
    (c) => (control(c, "aws_iam_role").force_detach_policies = true),
  ],
  [
    "embedded admin",
    (c) => (control(c, "aws_iam_role").inline_policy = [{ name: "admin" }]),
  ],
  [
    "attached admin",
    (c) =>
      (control(c, "aws_iam_role").managed_policy_arns = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
      ]),
  ],
  [
    "extra metadata source",
    (c) =>
      c.document.resource_changes.push({
        address: "data.aws_secretsmanager_secret_version.token[0]",
        mode: "data",
        type: "aws_secretsmanager_secret_version",
        name: "token",
        index: 0,
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["read"], after: {} },
      }),
  ],
  [
    "foreign caller",
    (c) => (control(c, "aws_caller_identity").account_id = "999999999999"),
  ],
  [
    "foreign caller ARN",
    (c) =>
      (control(c, "aws_caller_identity").arn =
        "arn:aws:iam::999999999999:role/Operator"),
  ],
  ["disabled key", (c) => (control(c, "aws_kms_key").key_state = "Disabled")],
  ["foreign returned key", (c) => (control(c, "aws_kms_key").arn = "foreign")],
  ["foreign key input", (c) => (control(c, "aws_kms_key").key_id = "foreign")],
  [
    "foreign OIDC",
    (c) =>
      (control(c, "aws_iam_openid_connect_provider").arn =
        "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"),
  ],
  [
    "foreign issuer",
    (c) =>
      (control(c, "aws_iam_openid_connect_provider").url =
        "https://issuer.example.test"),
  ],
  [
    "backend key",
    (c) => (c.review.backendKey = "meeting-notes-terraform/state"),
  ],
  [
    "variable mismatch",
    (c) => (c.document.variables.sandbox_account_id.value = "999999999999"),
  ],
  [
    "incomplete variable maps",
    (c) => {
      delete c.document.variables.github_owner_id;
      delete c.review.variables.github_owner_id;
    },
  ],
])
  refuse(`refuses ${label}`, alter);
for (const type of [
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_server_side_encryption_configuration",
])
  refuse(
    `refuses unknown controls for ${type}`,
    (c) => (resource(c, type).change.after_unknown = true),
  );
for (const [type, fields] of [
  [
    "aws_s3_bucket",
    [
      "acl",
      "grant",
      "policy",
      "lifecycle_rule",
      "replication_configuration",
      "object_lock_configuration",
      "logging",
      "website",
      "cors_rule",
      "server_side_encryption_configuration",
      "versioning",
    ],
  ],
  [
    "aws_iam_role",
    ["inline_policy", "managed_policy_arns", "permissions_boundary"],
  ],
]) {
  for (const field of fields)
    refuse(`refuses configured deferred ${type}.${field}`, (c) => {
      configured(c, type).expressions[field] = { references: ["future.id"] };
      control(c, type)[field] = null;
      resource(c, type).change.after_unknown[field] = true;
    });
  scenario(
    `permits unconfigured provider computed defaults for ${type}`,
    () => {
      const c = candidate();
      for (const field of fields) {
        control(c, type)[field] = null;
        resource(c, type).change.after_unknown[field] = true;
      }
      // A permissions boundary is security relevant even if the provider marks it computed.
      if (type === "aws_iam_role")
        delete resource(c, type).change.after_unknown.permissions_boundary;
      check.equal(inspect(c.document, c.review), true);
    },
  );
}
for (const [type, fields] of [
  ["aws_caller_identity", ["account_id", "arn"]],
  ["aws_kms_key", ["arn", "key_id", "key_state", "aws_account_id"]],
  ["aws_iam_openid_connect_provider", ["arn", "url", "client_id_list"]],
  ["aws_iam_role", ["permissions_boundary", "force_detach_policies"]],
])
  for (const field of fields)
    refuse(
      `refuses unknown ${type}.${field}`,
      (c) => (resource(c, type).change.after_unknown[field] = true),
    );
for (const audience of [
  [],
  ["prefix-sts.amazonaws.com"],
  ["sts.amazonaws.com.attacker.test"],
  "sts.amazonaws.com",
])
  refuse(
    `refuses unaccepted audience ${JSON.stringify(audience)}`,
    (c) =>
      (control(c, "aws_iam_openid_connect_provider").client_id_list = audience),
  );
scenario(
  "accepts the shared OIDC issuer with another existing audience",
  () => {
    const c = candidate();
    control(c, "aws_iam_openid_connect_provider").client_id_list.push(
      "another-existing-client",
    );
    check.equal(inspect(c.document, c.review), true);
  },
);
const documents = [
  ["aws_s3_bucket_policy", "policy", "bucket"],
  ["aws_iam_role", "assume_role_policy", "trust"],
  ["aws_iam_role_policy", "policy", "role"],
];
for (const [type, field, label] of documents) {
  refuse(
    `refuses changed ${label} bytes`,
    (c) => (control(c, type)[field] += " "),
  );
  refuse(
    `refuses unknown ${label}`,
    (c) => (resource(c, type).change.after_unknown[field] = true),
  );
  refuse(`refuses malformed independently hashed ${label}`, (c) => {
    control(c, type)[field] = "null";
    c.review.policySha256[label] = sha256("null");
  });
}
for (const action of [
  "iam:DeletePolicyVersion",
  "iam:SetDefaultPolicyVersion",
  "iam:PassRole",
  "iam:AttachRolePolicy",
  "*",
  "kms:PutKeyPolicy",
  "s3:DeleteObject",
]) {
  refuse(`refuses prohibited grant with matching hash ${action}`, (c) => {
    const policy = JSON.parse(control(c, "aws_iam_role_policy").policy);
    policy.Statement.push({ Effect: "Allow", Action: action, Resource: "*" });
    control(c, "aws_iam_role_policy").policy = JSON.stringify(policy);
    c.review.policySha256.role = sha256(JSON.stringify(policy));
  });
}
for (const key of [
  "administrator_role_arn",
  "reviewer_role_arn",
  "github_repository_id",
  "github_owner_id",
  "trusted_refs",
])
  refuse(`refuses invalid reviewed input ${key}`, (c) => {
    const value = key === "trusted_refs" ? ["refs/heads/*"] : "*";
    c.review.variables[key] = value;
    c.document.variables[key].value = value;
  });
refuse("refuses hashed wildcard branch trust", (c) => {
  const trust = JSON.parse(control(c, "aws_iam_role").assume_role_policy);
  trust.Statement[0].Condition.StringEquals[
    "token.actions.githubusercontent.com:ref"
  ] = "refs/heads/*";
  control(c, "aws_iam_role").assume_role_policy = JSON.stringify(trust);
  c.review.policySha256.trust = sha256(JSON.stringify(trust));
});
scenario(
  "accepts native Terraform mock changes against fixed independent hashes",
  { skip: !process.env.SANDBOX_BOOTSTRAP_MOCK_PLAN_JSONL },
  async () => {
    const lines = require("node:readline").createInterface({
      input: createReadStream(process.env.SANDBOX_BOOTSTRAP_MOCK_PLAN_JSONL),
    });
    let actual;
    for await (const line of lines) {
      const item = JSON.parse(line);
      if (item.type === "test_plan" && item["@testrun"] === "enabled")
        actual = item.test_plan;
    }
    check.ok(actual, "enabled native event missing");
    const c = candidate();
    c.document.resource_changes = actual.resource_changes;
    check.equal(inspect(c.document, c.review), true);
    for (const [output, label] of [
      ["bucket_policy", "bucket"],
      ["terraform_role_policy", "role"],
      ["terraform_role_trust_policy", "trust"],
    ])
      check.equal(
        sha256(actual.output_changes[output].after),
        c.review.policySha256[label],
      );
  },
);
scenario(
  "compact removes schemas while preserving required mock evidence",
  () => {
    const event = {
      type: "test_plan",
      "@testrun": "enabled",
      test_plan: {
        resource_changes: [],
        output_changes: {},
        plan_format_version: "1.2",
        provider_schemas: { large: true },
      },
    };
    const result = compact(JSON.stringify(event));
    check.equal(result.test_plan.plan_format_version, "1.2");
    check.ok(!Object.hasOwn(result.test_plan, "provider_schemas"));
    check.throws(() => compact('{"type":"test_summary"}'));
  },
);
scenario(
  "Task1 Plan session intersects the base policy without application/state writes",
  () => {
    const workflow = readFileSync(
      join(__dirname, "../../.github/workflows/terraform-plan.yml"),
      "utf8",
    );
    const session = JSON.parse(
      load(workflow).jobs.plan.steps.find(
        (step) => step.name === "Configure Sandbox AWS credentials",
      ).with["inline-session-policy"],
    );
    check.ok(JSON.stringify(session).length <= 2048);
    const trial = candidate();
    const base = JSON.parse(
      trial.document.resource_changes[7].change.after.policy,
    );
    const matches = (pattern, value) => {
      const escaped = pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp("^" + escaped + "$", "i").test(value);
    };
    const allowed = (policy, action, resource) =>
      policy.Statement.some(
        (s) =>
          s.Effect === "Allow" &&
          [s.Action].flat().some((a) => matches(a, action)) &&
          [s.Resource].flat().some((r) => matches(r, resource)),
      );
    const effective = (action, resource) =>
      allowed(base, action, resource) && allowed(session, action, resource);
    const account = trial.review.variables.sandbox_account_id;
    for (const [action, resource, expected] of [
      [
        "dynamodb:DescribeTable",
        `arn:aws:dynamodb:us-east-1:${account}:table/meeting-notes-sandbox-MeetingHistoryTable`,
        true,
      ],
      [
        "dynamodb:UpdateTable",
        `arn:aws:dynamodb:us-east-1:${account}:table/meeting-notes-sandbox-MeetingHistoryTable`,
        false,
      ],
      [
        "iam:CreatePolicyVersion",
        `arn:aws:iam::${account}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        false,
      ],
      [
        "s3:PutObject",
        "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
        false,
      ],
      [
        "s3:PutObject",
        `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${account}/terraform/sandbox/run/plan`,
        true,
      ],
      [
        "s3:GetObject",
        `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${account}/terraform/sandbox/run/plan`,
        false,
      ],
      [
        "dynamodb:GetItem",
        `arn:aws:dynamodb:us-east-1:${account}:table/meeting-notes-sandbox-MeetingHistoryTable`,
        false,
      ],
      ["kms:PutKeyPolicy", trial.review.variables.kms_key_arn, false],
      [
        "iam:DeletePolicyVersion",
        `arn:aws:iam::${account}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        false,
      ],
    ])
      check.equal(effective(action, resource), expected, action);
  },
);

scenario(
  "accepts an independently reviewed alternate synthetic account and repository binding",
  () => {
    const c = candidate();
    const previous = structuredClone(c.review.variables);
    const next = {
      ...previous,
      sandbox_account_id: "321098765432",
      github_repository_id: "987654321",
      github_owner_id: "7654321",
    };
    for (const key of [
      "kms_key_arn",
      "administrator_role_arn",
      "reviewer_role_arn",
    ])
      next[key] = previous[key].replace(
        previous.sandbox_account_id,
        next.sandbox_account_id,
      );
    function translate(value) {
      if (Array.isArray(value)) return value.map(translate);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, translate(item)]),
        );
      if (typeof value !== "string") return value;
      for (const key of [
        "kms_key_arn",
        "administrator_role_arn",
        "reviewer_role_arn",
        "github_repository_id",
        "github_owner_id",
        "sandbox_account_id",
      ])
        if (value === previous[key]) return next[key];
      if (value.startsWith("{"))
        return JSON.stringify(translate(JSON.parse(value)));
      return value.replaceAll(
        previous.sandbox_account_id,
        next.sandbox_account_id,
      );
    }
    c.document = translate(c.document);
    c.review.variables = next;
    for (const [type, field, label] of documents)
      c.review.policySha256[label] = sha256(control(c, type)[field]);
    check.equal(inspect(c.document, c.review), true);
  },
);

for (const kind of [
  "aws_s3_bucket",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_policy",
]) {
  refuse(`review F1 refuses resolved foreign region for ${kind}`, (c) => {
    control(c, kind).region = "us-west-2";
    delete resource(c, kind).change.after_unknown.region;
  });
  refuse(`review F1 refuses configured foreign region for ${kind}`, (c) => {
    configured(c, kind).expressions.region = { constant_value: "us-west-2" };
  });
}
refuse("review F1 refuses versioning MFA-delete enablement", (c) => {
  control(
    c,
    "aws_s3_bucket_versioning",
  ).versioning_configuration[0].mfa_delete = "Enabled";
  delete resource(c, "aws_s3_bucket_versioning").change.after_unknown
    .versioning_configuration[0].mfa_delete;
  configured(
    c,
    "aws_s3_bucket_versioning",
  ).expressions.versioning_configuration = {
    constant_value: [{ status: "Enabled", mfa_delete: "Enabled" }],
  };
});
refuse("review F1 refuses configured deferred MFA-delete", (c) => {
  configured(
    c,
    "aws_s3_bucket_versioning",
  ).expressions.versioning_configuration = [
    { mfa_delete: { references: ["future.mfa_delete"] } },
  ];
});
refuse(
  "review F1 refuses a versioning MFA credential",
  (c) => (control(c, "aws_s3_bucket_versioning").mfa = "serial token"),
);
refuse("review F1 refuses a configured deferred MFA credential", (c) => {
  configured(c, "aws_s3_bucket_versioning").expressions.mfa = {
    references: ["future.token"],
  };
  resource(c, "aws_s3_bucket_versioning").change.after_unknown.mfa = true;
});
refuse(
  "review F1 refuses a foreign expected bucket owner",
  (c) =>
    (control(c, "aws_s3_bucket_versioning").expected_bucket_owner =
      "999999999999"),
);
refuse(
  "review F1 refuses incompatible blocked encryption types",
  (c) =>
    (control(
      c,
      "aws_s3_bucket_server_side_encryption_configuration",
    ).rule[0].blocked_encryption_types = ["SSE-KMS"]),
);
refuse(
  "review F1 refuses configured deferred encryption controls",
  (c) =>
    (configured(
      c,
      "aws_s3_bucket_server_side_encryption_configuration",
    ).expressions.rule = [
      { blocked_encryption_types: { references: ["future.controls"] } },
    ]),
);
scenario(
  "review F1 permits justified unconfigured provider-computed security defaults",
  () => {
    const c = candidate();
    control(
      c,
      "aws_s3_bucket_versioning",
    ).versioning_configuration[0].mfa_delete = "Disabled";
    delete resource(c, "aws_s3_bucket_versioning").change.after_unknown
      .versioning_configuration[0].mfa_delete;
    control(
      c,
      "aws_s3_bucket_server_side_encryption_configuration",
    ).rule[0].blocked_encryption_types = ["SSE-C"];
    delete resource(c, "aws_s3_bucket_server_side_encryption_configuration")
      .change.after_unknown.rule[0].blocked_encryption_types;
    check.equal(inspect(c.document, c.review), true);
  },
);
scenario(
  "review F1 permits the exact reviewed resolved and configured region",
  () => {
    const c = candidate();
    for (const entry of c.document.resource_changes.filter(
      (r) => r.mode === "managed" && r.type.startsWith("aws_s3_"),
    )) {
      entry.change.after.region = c.review.variables.aws_region;
      delete entry.change.after_unknown.region;
      configured(c, entry.type).expressions.region = {
        constant_value: c.review.variables.aws_region,
      };
    }
    check.equal(inspect(c.document, c.review), true);
  },
);
