const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { validateBootstrapPlan } = require("./verify-plan.cjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  return {
    plan: JSON.parse(
      readFileSync(join(__dirname, "tests/fixtures/create-plan.json"), "utf8"),
    ),
    binding: JSON.parse(
      readFileSync(
        join(__dirname, "tests/fixtures/reviewed-binding.json"),
        "utf8",
      ),
    ),
  };
}
test("accepts only the reviewed eight-resource create plan", () => {
  const { plan, binding } = fixture();
  assert.equal(validateBootstrapPlan(plan, binding), true);
});
for (const [name, mutate] of [
  [
    "embedded role policy",
    ({ plan }) =>
      (plan.resource_changes[6].change.after.inline_policy = [
        { name: "admin", policy: '{"Statement":[]}' },
      ]),
  ],
  [
    "embedded expiration",
    ({ plan }) =>
      (plan.resource_changes[0].change.after.lifecycle_rule = [
        { expiration: [{ days: 1 }] },
      ]),
  ],
  [
    "object lock",
    ({ plan }) =>
      (plan.resource_changes[0].change.after.object_lock_enabled = true),
  ],
  [
    "replacement",
    ({ plan }) =>
      (plan.resource_changes[0].change.actions = ["delete", "create"]),
  ],
  [
    "import",
    ({ plan }) =>
      (plan.resource_changes[0].change.importing = { id: "existing" }),
  ],
  [
    "move",
    ({ plan }) => (plan.resource_changes[0].previous_address = "old.bucket"),
  ],
  [
    "duplicate address",
    ({ plan }) =>
      (plan.resource_changes[1] = structuredClone(plan.resource_changes[0])),
  ],
  [
    "extra resource",
    ({ plan }) =>
      plan.resource_changes.push({
        ...plan.resource_changes[0],
        address: "aws_kms_key.extra",
      }),
  ],
  ["missing resource", ({ plan }) => plan.resource_changes.splice(7, 1)],
  [
    "wrong key",
    ({ plan }) =>
      (plan.resource_changes[4].change.after.rule[0].apply_server_side_encryption_by_default[0].kms_master_key_id =
        "other"),
  ],
  [
    "wrong policy",
    ({ plan }) =>
      (plan.resource_changes[5].change.after.policy =
        '{"Statement":[{"Effect":"Allow"}]}'),
  ],
  [
    "unknown policy",
    ({ plan }) =>
      (plan.resource_changes[5].change.after_unknown = { policy: true }),
  ],
  [
    "force destroy",
    ({ plan }) => (plan.resource_changes[0].change.after.force_destroy = true),
  ],
  [
    "wrong identity binding",
    ({ plan }) => (plan.variables.production_account_id.value = "999999999999"),
  ],
  [
    "wrong state binding",
    ({ binding }) => (binding.backendKey = "meeting-notes-terraform/state"),
  ],
  [
    "extra data read",
    ({ plan }) =>
      plan.resource_changes.push({
        address: "data.aws_secretsmanager_secret_version.token",
        mode: "data",
        change: { actions: ["read"] },
      }),
  ],
  ["deferred work", ({ plan }) => (plan.deferred_changes = [{}])],
  [
    "malformed change",
    ({ plan }) => delete plan.resource_changes[0].change.after,
  ],
  ["incomplete plan", ({ plan }) => (plan.complete = false)],
  ["malformed plan", ({ plan }) => (plan.resource_changes = null)],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });

test("permits unrelated computed block defaults while checking configured encryption", () => {
  const { plan, binding } = fixture();
  plan.resource_changes[4].change.after_unknown = {
    rule: [
      {
        apply_server_side_encryption_by_default: [{}],
        blocked_encryption_types: true,
      },
    ],
  };
  assert.equal(validateBootstrapPlan(plan, binding), true);
});

for (const [name, mutate] of [
  [
    "managed policy attachment",
    (f) =>
      (f.plan.resource_changes[6].change.after.managed_policy_arns = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
      ]),
  ],
  [
    "non-root role path",
    (f) => (f.plan.resource_changes[6].change.after.path = "/hidden/"),
  ],
  [
    "unknown role path",
    (f) => (f.plan.resource_changes[6].change.after_unknown.path = true),
  ],
  [
    "foreign data key",
    (f) => (f.plan.resource_changes[9].change.after.key_id = "foreign"),
  ],
  [
    "foreign returned key",
    (f) => (f.plan.resource_changes[9].change.after.arn = "foreign"),
  ],
  [
    "foreign caller account",
    (f) =>
      (f.plan.resource_changes[8].change.after.account_id = "999999999999"),
  ],
  [
    "foreign caller ARN",
    (f) =>
      (f.plan.resource_changes[8].change.after.arn =
        "arn:aws:sts::999999999999:assumed-role/Administrator/offline"),
  ],
  [
    "foreign OIDC ARN",
    (f) =>
      (f.plan.resource_changes[10].change.after.arn =
        "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"),
  ],
  [
    "foreign OIDC URL",
    (f) =>
      (f.plan.resource_changes[10].change.after.url =
        "https://other.example.com"),
  ],
  [
    "OIDC missing STS audience",
    (f) =>
      (f.plan.resource_changes[10].change.after.client_id_list = ["other"]),
  ],
  [
    "disabled data key",
    (f) => (f.plan.resource_changes[9].change.after.key_state = "Disabled"),
  ],
  [
    "deferred key identity",
    (f) => {
      f.plan.resource_changes[9].change.actions = ["read"];
      delete f.plan.resource_changes[9].change.after.arn;
      f.plan.resource_changes[9].change.after_unknown.arn = true;
    },
  ],
  [
    "mismatched resource type",
    (f) =>
      (f.plan.resource_changes[9].type = "aws_secretsmanager_secret_version"),
  ],
  [
    "mismatched resource name",
    (f) => (f.plan.resource_changes[9].name = "other"),
  ],
  ["mismatched resource index", (f) => (f.plan.resource_changes[9].index = 1)],
  ["missing configuration", (f) => delete f.plan.configuration],
  [
    "unknown required bucket controls",
    (f) => (f.plan.resource_changes[0].change.after_unknown = true),
  ],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });
for (const [index, fields] of [
  [
    0,
    [
      "lifecycle_rule",
      "replication_configuration",
      "object_lock_configuration",
      "grant",
      "policy",
      "acl",
      "logging",
      "website",
      "cors_rule",
      "server_side_encryption_configuration",
      "versioning",
    ],
  ],
  [6, ["inline_policy", "managed_policy_arns", "permissions_boundary"]],
]) {
  for (const key of fields)
    test(`rejects configured deferred ${key}`, () => {
      const f = fixture();
      f.plan.configuration.root_module.resources[index].expressions[key] = {
        references: ["var.deferred"],
      };
      f.plan.resource_changes[index].change.after_unknown[key] = true;
      assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
    });
  test(`accepts unconfigured provider-computed fields for resource ${index}`, () => {
    const f = fixture();
    for (const key of fields.filter(
      (k) => !["permissions_boundary", "object_lock_configuration"].includes(k),
    ))
      f.plan.resource_changes[index].change.after_unknown[key] = true;
    assert.equal(validateBootstrapPlan(f.plan, f.binding), true);
  });
}
for (const [index, key] of [
  [8, "account_id"],
  [8, "arn"],
  [9, "key_id"],
  [9, "arn"],
  [9, "aws_account_id"],
  [9, "key_state"],
  [10, "arn"],
  [10, "url"],
  [10, "client_id_list"],
])
  test(`rejects unknown data ${index}.${key}`, () => {
    const f = fixture();
    f.plan.resource_changes[index].change.after_unknown[key] = true;
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });
for (const key of ["permissions_boundary", "force_detach_policies"])
  test(`rejects unknown IAM ${key}`, () => {
    const f = fixture();
    f.plan.resource_changes[6].change.after_unknown[key] = true;
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });
for (const invalid of [
  null,
  true,
  "policy",
  1,
  [],
  {},
  { Version: "2012-10-17", Statement: [] },
  {
    Version: "bad",
    Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
  },
  { Version: "2012-10-17", Statement: [null] },
  { Version: "2012-10-17", Statement: [{ Effect: "Allow", Resource: "*" }] },
  {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "s3:GetObject" }],
  },
])
  test(`rejects malformed reviewed policy ${JSON.stringify(invalid)}`, () => {
    const f = fixture();
    const policy = JSON.stringify(invalid);
    f.plan.resource_changes[7].change.after.policy = policy;
    f.binding.policySha256.role = sha(policy);
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });

test("rejects matching incomplete variable maps", () => {
  const f = fixture();
  delete f.plan.variables.administrator_role_arn;
  delete f.binding.variables.administrator_role_arn;
  assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
});
test("rejects nested unknown OIDC audience", () => {
  const f = fixture();
  f.plan.resource_changes[10].change.after_unknown.client_id_list = [true];
  assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
});
for (const principal of [1, [], {}, { AWS: [] }])
  test(`rejects malformed reviewed bucket principal ${JSON.stringify(principal)}`, () => {
    const f = fixture();
    const document = JSON.parse(f.plan.resource_changes[5].change.after.policy);
    document.Statement[0].Principal = principal;
    const policy = JSON.stringify(document);
    f.plan.resource_changes[5].change.after.policy = policy;
    f.binding.policySha256.bucket = sha(policy);
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });

test(
  "accepts the actual Terraform mocked eight creates and rendered policies",
  { skip: !process.env.BOOTSTRAP_MOCK_PLAN_JSONL },
  async () => {
    const { createReadStream } = require("node:fs");
    const { createInterface } = require("node:readline");
    const lines = createInterface({
      input: createReadStream(process.env.BOOTSTRAP_MOCK_PLAN_JSONL),
      crlfDelay: Infinity,
    });
    let rendered;
    for await (const line of lines) {
      if (!line.includes('"test_plan"')) continue;
      const event = JSON.parse(line.replace(/^\uFEFF/, ""));
      if (event.type === "test_plan" && event["@testrun"] === "enabled") {
        rendered = event.test_plan;
        break;
      }
    }
    assert.ok(rendered, "missing enabled mock plan");
    const f = fixture();
    // Mock output contains actual managed changes but omits the reviewed envelope.
    f.plan.resource_changes = rendered.resource_changes;
    f.binding.variables.kms_key_arn =
      "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111";
    f.binding.variables.reviewer_role_arn =
      f.binding.variables.administrator_role_arn;
    f.plan.variables = Object.fromEntries(
      Object.entries(f.binding.variables).map(([key, value]) => [
        key,
        { value },
      ]),
    );
    for (const [output, name] of [
      ["bucket_policy", "bucket"],
      ["terraform_role_policy", "role"],
      ["terraform_role_trust_policy", "trust"],
    ])
      f.binding.policySha256[name] = sha(rendered.output_changes[output].after);
    assert.equal(validateBootstrapPlan(f.plan, f.binding), true);
  },
);

test("compacts only the enabled mock changes and outputs", () => {
  const { compactMockPlan } = require("./compact-mock-plan.cjs");
  const event = {
    type: "test_plan",
    "@testrun": "enabled",
    test_plan: {
      resource_changes: [],
      output_changes: {},
      provider_schemas: { ignored: true },
    },
  };
  assert.deepEqual(compactMockPlan(JSON.stringify(event)), {
    type: "test_plan",
    "@testrun": "enabled",
    test_plan: { resource_changes: [], output_changes: {} },
  });
  assert.throws(() => compactMockPlan('{"type":"test_summary"}'));
});

test("accepts the pinned provider's scheme-less GitHub issuer readback", () => {
  const f = fixture();
  f.plan.resource_changes[10].change.after.url =
    "token.actions.githubusercontent.com";
  assert.equal(validateBootstrapPlan(f.plan, f.binding), true);
});

for (const audiences of [
  ["prefix-sts.amazonaws.com"],
  ["sts.amazonaws.com.attacker.example"],
  ["https://attacker.example/sts.amazonaws.com/path"],
  "sts.amazonaws.com",
])
  test(`rejects an OIDC audience without an exact STS array member: ${JSON.stringify(audiences)}`, () => {
    const f = fixture();
    f.plan.resource_changes[10].change.after.client_id_list = audiences;
    assert.throws(() => validateBootstrapPlan(f.plan, f.binding));
  });

test("accepts another OIDC audience alongside the exact STS audience", () => {
  const f = fixture();
  f.plan.resource_changes[10].change.after.client_id_list = [
    "another-client",
    "sts.amazonaws.com",
  ];
  assert.equal(validateBootstrapPlan(f.plan, f.binding), true);
});
