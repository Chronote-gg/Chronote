"use strict";
const strict = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const AWS = "registry.terraform.io/hashicorp/aws";
const VARIABLE_NAMES = [
  "administrator_role_arn",
  "aws_region",
  "enable_private_evidence_store",
  "enable_sandbox_terraform_role",
  "environment",
  "github_owner_id",
  "github_repository_id",
  "kms_key_arn",
  "reviewer_role_arn",
  "sandbox_account_id",
  "trusted_refs",
];
const TRUSTED_REFS = [
  "refs/heads/codex/sandbox-terraform-capture",
  "refs/heads/master",
];
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const insist = (condition, reason) => strict.ok(condition, reason);

function bindingVariables(binding) {
  strict.equal(
    binding.backendKey,
    "meeting-notes-terraform/sandbox-bootstrap/state",
  );
  const input = binding.variables;
  strict.deepEqual(Object.keys(input).sort(), VARIABLE_NAMES);
  strict.match(input.sandbox_account_id, /^\d{12}$/);
  strict.equal(input.environment, "sandbox");
  strict.equal(input.aws_region, "us-east-1");
  insist(
    input.enable_private_evidence_store === true &&
      input.enable_sandbox_terraform_role === true,
    "both reviewed flags must be enabled",
  );
  strict.deepEqual(input.trusted_refs, TRUSTED_REFS);
  strict.match(
    input.kms_key_arn,
    new RegExp(
      `^arn:aws:kms:us-east-1:${input.sandbox_account_id}:key/[a-f0-9-]{36}$`,
    ),
  );
  for (const field of ["github_owner_id", "github_repository_id"])
    strict.match(input[field], /^[1-9][0-9]+$/);
  const excluded = [
    "github-terraform",
    "ecs-task-app-role",
    "ecs-task-exec-role",
  ];
  for (const field of ["administrator_role_arn", "reviewer_role_arn"]) {
    strict.match(
      input[field],
      new RegExp(
        `^arn:aws:iam::${input.sandbox_account_id}:role/[A-Za-z0-9_+=,.@/-]+$`,
      ),
    );
    insist(
      !excluded.some(
        (name) =>
          input[field] ===
          `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-${name}`,
      ),
      "executor/runtime cannot be the administrator or reader",
    );
  }
  return input;
}

function managedValues(input) {
  const bucket = `meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`;
  const role = "meeting-notes-sandbox-github-terraform";
  return {
    aws_s3_bucket: { bucket, force_destroy: false },
    aws_s3_bucket_public_access_block: {
      bucket,
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    },
    aws_s3_bucket_ownership_controls: {
      bucket,
      rule: [{ object_ownership: "BucketOwnerEnforced" }],
    },
    aws_s3_bucket_versioning: {
      bucket,
      versioning_configuration: [{ status: "Enabled" }],
    },
    aws_s3_bucket_server_side_encryption_configuration: {
      bucket,
      rule: [
        {
          bucket_key_enabled: false,
          apply_server_side_encryption_by_default: [
            { sse_algorithm: "aws:kms", kms_master_key_id: input.kms_key_arn },
          ],
        },
      ],
    },
    aws_s3_bucket_policy: { bucket },
    aws_iam_role: { name: role, path: "/", max_session_duration: 3600 },
    aws_iam_role_policy: {
      name: "meeting-notes-sandbox-terraform-prerequisites",
      role,
    },
  };
}
function resourceName(type) {
  return type.startsWith("aws_s3_") ? "private_evidence" : "sandbox_terraform";
}
function metadataValues(input) {
  return {
    aws_caller_identity: ["current", { account_id: input.sandbox_account_id }],
    aws_kms_key: [
      "existing",
      {
        key_id: input.kms_key_arn,
        arn: input.kms_key_arn,
        aws_account_id: input.sandbox_account_id,
        key_state: "Enabled",
      },
    ],
    aws_iam_openid_connect_provider: [
      "github",
      {
        arn: `arn:aws:iam::${input.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com`,
      },
    ],
  };
}
function knownShape(actual, unknown, wanted) {
  insist(unknown !== true, "unknown required control");
  if (Array.isArray(wanted)) {
    insist(
      Array.isArray(actual) && actual.length === wanted.length,
      "changed control block",
    );
    wanted.forEach((entry, index) =>
      knownShape(actual[index], unknown?.[index], entry),
    );
  } else if (wanted !== null && typeof wanted === "object") {
    insist(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      "missing control block",
    );
    for (const field of Object.keys(wanted))
      knownShape(actual[field], unknown?.[field], wanted[field]);
  } else strict.deepEqual(actual, wanted);
}
function noEmbeddedControls(change, config, fields) {
  for (const field of fields) {
    insist(
      !Object.hasOwn(config.expressions, field),
      `configured embedded ${field}`,
    );
    const control = change.after[field];
    insist(
      control == null || (Array.isArray(control) && control.length === 0),
      `embedded ${field}`,
    );
  }
}
function validateStorageAndRole(entry, config) {
  const { change, type } = entry;
  if (type === "aws_s3_bucket") {
    noEmbeddedControls(change, config, [
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
    ]);
    insist(
      !Object.hasOwn(config.expressions, "object_lock_enabled") &&
        change.after.object_lock_enabled !== true,
      "object lock is outside this bootstrap",
    );
  }
  if (type === "aws_iam_role") {
    noEmbeddedControls(change, config, [
      "inline_policy",
      "managed_policy_arns",
      "permissions_boundary",
    ]);
    knownShape(
      change.after.permissions_boundary ?? null,
      change.after_unknown?.permissions_boundary,
      null,
    );
    knownShape(
      change.after.force_detach_policies ?? false,
      change.after_unknown?.force_detach_policies,
      false,
    );
  }
}
function approvedPolicy(entry, binding) {
  const fields = {
    aws_s3_bucket_policy: ["policy", "bucket", expectedBucketPolicy],
    aws_iam_role: ["assume_role_policy", "trust", expectedTrustPolicy],
    aws_iam_role_policy: ["policy", "role", expectedRolePolicy],
  };
  const selection = fields[entry.type];
  if (!selection) return;
  const [field, label, contract] = selection;
  insist(
    entry.change.after_unknown?.[field] !== true,
    "unknown policy document",
  );
  const bytes = entry.change.after[field];
  strict.match(binding.policySha256[label], /^[a-f0-9]{64}$/);
  strict.equal(
    digest(bytes),
    binding.policySha256[label],
    `unreviewed ${label} policy bytes`,
  );
  strict.deepEqual(
    JSON.parse(bytes),
    contract(binding.variables),
    `changed ${label} security contract`,
  );
}
function validateMetadata(entry, input, approved) {
  const [name, values] = approved[entry.type] ?? [];
  insist(name && entry.name === name, "unapproved metadata source");
  strict.equal(entry.address, `data.${entry.type}.${name}[0]`);
  insist(
    entry.change.actions.length === 1 &&
      ["read", "no-op"].includes(entry.change.actions[0]),
    "metadata effects refused",
  );
  knownShape(entry.change.after, entry.change.after_unknown, values);
  if (entry.type === "aws_caller_identity") {
    knownShape(
      entry.change.after.arn,
      entry.change.after_unknown?.arn,
      entry.change.after.arn,
    );
    strict.match(
      entry.change.after.arn,
      new RegExp(`^arn:aws:(iam|sts)::${input.sandbox_account_id}:.+$`),
    );
  }
  if (entry.type === "aws_iam_openid_connect_provider") {
    const result = entry.change.after;
    knownShape(result.url, entry.change.after_unknown?.url, result.url);
    insist(
      [
        "token.actions.githubusercontent.com",
        "https://token.actions.githubusercontent.com",
      ].includes(result.url),
      "foreign OIDC issuer",
    );
    knownShape(
      result.client_id_list,
      entry.change.after_unknown?.client_id_list,
      result.client_id_list,
    );
    insist(
      Array.isArray(result.client_id_list) &&
        result.client_id_list.includes("sts.amazonaws.com"),
      "STS audience absent",
    );
  }
}
function configuredResources(plan, managed, metadata) {
  const module = plan.configuration.root_module;
  strict.deepEqual(module.child_modules ?? [], []);
  const configs = module.resources;
  insist(Array.isArray(configs), "resource configuration missing");
  const unique = new Set();
  for (const config of configs) {
    const name =
      config.mode === "data"
        ? metadata[config.type]?.[0]
        : resourceName(config.type);
    const address = `${config.mode === "data" ? "data." : ""}${config.type}.${name}`;
    insist(
      (config.mode === "data"
        ? Object.hasOwn(metadata, config.type)
        : Object.hasOwn(managed, config.type)) && config.address === address,
      "foreign configuration",
    );
    insist(!unique.has(address), "duplicate configuration");
    insist(
      !config.provider_config_key || config.provider_config_key === "aws",
      "foreign provider configuration",
    );
    unique.add(address);
  }
  return configs;
}
function validateBootstrapPlan(plan, binding) {
  const input = bindingVariables(binding);
  strict.deepEqual(
    [
      plan.format_version,
      plan.terraform_version,
      plan.applyable,
      plan.complete,
      plan.errored,
    ],
    ["1.2", "1.16.0", true, true, false],
    "incomplete or unsupported saved plan",
  );
  for (const field of [
    "deferred_changes",
    "resource_drift",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    strict.deepEqual(plan[field] ?? [], [], `unreviewed ${field}`);
  strict.deepEqual(
    Object.fromEntries(
      Object.entries(plan.variables).map(([name, value]) => [
        name,
        value.value,
      ]),
    ),
    input,
  );
  const managed = managedValues(input);
  const metadata = metadataValues(input);
  const configs = configuredResources(plan, managed, metadata);
  const seen = new Set();
  insist(Array.isArray(plan.resource_changes), "missing changes");
  for (const entry of plan.resource_changes) {
    strict.equal(entry.provider_name, AWS);
    strict.equal(entry.index, 0);
    insist(!seen.has(entry.address), "duplicate change");
    insist(
      !Object.hasOwn(entry, "previous_address") &&
        !Object.hasOwn(entry.change, "importing"),
      "move/import refused",
    );
    seen.add(entry.address);
    const config = configs.find(
      (item) => item.address === entry.address.replace(/\[0\]$/, ""),
    );
    insist(
      config &&
        config.mode === entry.mode &&
        config.type === entry.type &&
        config.name === entry.name,
      "configuration identity mismatch",
    );
    validateResourceBindings(entry, config, input);
    if (entry.mode === "data") validateMetadata(entry, input, metadata);
    else {
      strict.equal(entry.mode, "managed");
      insist(Object.hasOwn(managed, entry.type), "extra managed resource");
      strict.equal(
        entry.address,
        `${entry.type}.${resourceName(entry.type)}[0]`,
      );
      strict.deepEqual(entry.change.actions, ["create"]);
      strict.equal(entry.change.before, null);
      knownShape(
        entry.change.after,
        entry.change.after_unknown,
        managed[entry.type],
      );
      validateStorageAndRole(entry, config);
      validateAdditionalStorageControls(entry, config);
      approvedPolicy(entry, binding);
    }
  }
  insist(
    Object.keys(managed).every((type) =>
      seen.has(`${type}.${resourceName(type)}[0]`),
    ),
    "missing one of eight creates",
  );
  return true;
}
module.exports = { validateBootstrapPlan };
if (require.main === module) {
  insist(
    process.argv.length === 4,
    "usage: node verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON",
  );
  validateBootstrapPlan(
    ...process.argv
      .slice(2)
      .map((path) => JSON.parse(fs.readFileSync(path, "utf8"))),
  );
}

// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedBucketPolicy(input) {
  const reviewedReaders = [
    `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
    input.reviewer_role_arn,
  ];
  return {
    Statement: [
      {
        Action: "s3:*",
        Condition: {
          Bool: {
            "aws:SecureTransport": "false",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "TLSOnly",
      },
      {
        Action: "s3:*",
        Condition: {
          ArnNotEquals: {
            "aws:PrincipalArn": [
              `${input.administrator_role_arn}`,
              `${input.reviewer_role_arn}`,
              `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
            ],
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "OnlyReviewedPrincipals",
      },
      {
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
          },
        },
        Effect: "Deny",
        NotAction: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:PutObject",
          "s3:GetObjectVersion",
        ],
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "CaptureCannotAdminister",
      },
      {
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `${input.reviewer_role_arn}`,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
        },
        Effect: "Deny",
        NotAction: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:GetObjectVersion",
          "s3:ListBucketVersions",
        ],
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "ReviewerCannotWrite",
      },
      {
        Action: "s3:ListBucketVersions",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `${input.reviewer_role_arn}`,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
          StringNotLike: {
            "s3:prefix": "terraform/sandbox/*",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "ReviewerNamespaceListOnly",
      },
      {
        Action: ["s3:PutObject", "s3:GetObjectVersion"],
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
        },
        Effect: "Deny",
        NotResource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Principal: "*",
        Sid: "CaptureNamespaceOnly",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:if-none-match": "*",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ConditionalCreateOnly",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption": "aws:kms",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ExactKMSAlgorithm",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ExactKMSKey",
      },
      {
        Action: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
        ],
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "ControlReadback",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
          },
          StringEquals: {
            "s3:if-none-match": "*",
            "s3:x-amz-server-side-encryption": "aws:kms",
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ConditionalCapture",
      },
      {
        Action: "s3:GetObjectVersion",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ExactVersionReview",
      },
    ],
    Version: "2012-10-17",
  };
}

// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedTrustPolicy(input) {
  return {
    Statement: [
      {
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:ref": [
              "refs/heads/codex/sandbox-terraform-capture",
              "refs/heads/master",
            ],
            "token.actions.githubusercontent.com:repository_id": `${input.github_repository_id}`,
            "token.actions.githubusercontent.com:repository_owner_id": `${input.github_owner_id}`,
            "token.actions.githubusercontent.com:sub":
              "repo:Chronote-gg/Chronote:environment:sandbox",
          },
        },
        Effect: "Allow",
        Principal: {
          Federated: `arn:aws:iam::${input.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com`,
        },
      },
    ],
    Version: "2012-10-17",
  };
}

// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedRolePolicy(input) {
  return {
    Statement: [
      {
        Action: ["s3:GetObject", "s3:PutObject"],
        Effect: "Allow",
        Resource:
          "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
        Sid: "ApplicationState",
      },
      {
        Action: "s3:ListBucket",
        Condition: {
          StringEquals: {
            "s3:prefix": [
              "meeting-notes-terraform/",
              "meeting-notes-terraform/sandbox/",
            ],
          },
        },
        Effect: "Allow",
        Resource: "arn:aws:s3:::meeting-notes-terraform-state-bucket",
        Sid: "WorkspaceDiscovery",
      },
      {
        Action: "dynamodb:DescribeTable",
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-terraform-state-locks`,
        Sid: "StateLockMetadata",
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [
              "meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
              "meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state-md5",
            ],
          },
        },
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-terraform-state-locks`,
        Sid: "SandboxStateLocks",
      },
      {
        Action: [
          "dynamodb:DescribeTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource",
        ],
        Effect: "Allow",
        Resource: [
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AccessLogsTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ActiveMeetingTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AskConversationTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AutoRecordSettingsTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ChannelContextTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ChatTtsUsageTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ConfigOverridesTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ContactFeedbackTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-DeploymentControlTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-DictionaryTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-EntitlementGrantTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-FeedbackTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-GuildSubscriptionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-InstallerTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-InteractionReceiptTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-McpOAuthTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingControlCommandTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingHistoryTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingShareTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingUserIndexTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-NotionIntegrationTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-OnboardingStateTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PaymentTransactionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PersonalMediaUploadJobTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PersonalRecordingSegmentTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-RecordingTranscriptTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ServerContextTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-SessionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-StripeWebhookEventTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-UserSpeechSettingsTable`,
        ],
        Sid: "TableMetadata",
      },
      {
        Action: ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"],
        Effect: "Allow",
        Resource: `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        Sid: "RuntimePolicyMetadata",
      },
      {
        Action: [
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListResourceTags",
        ],
        Effect: "Allow",
        Resource: `${input.kms_key_arn}`,
        Sid: "KeyMetadata",
      },
      {
        Action: "dynamodb:UpdateTable",
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingHistoryTable`,
        Sid: "HistoryDeliveryIndex",
      },
      {
        Action: ["iam:ListPolicyVersions", "iam:CreatePolicyVersion"],
        Effect: "Allow",
        Resource: `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        Sid: "RuntimePolicyVersion",
      },
      {
        Action: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
        ],
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "CaptureControls",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringEquals: {
            "s3:if-none-match": "*",
            "s3:x-amz-server-side-encryption": "aws:kms",
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ConditionalCapture",
      },
      {
        Action: "s3:GetObjectVersion",
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ExactVersionCapture",
      },
      {
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Condition: {
          StringEquals: {
            "kms:CallerAccount": `${input.sandbox_account_id}`,
            "kms:ViaService": "s3.us-east-1.amazonaws.com",
          },
          StringLike: {
            "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
          },
        },
        Effect: "Allow",
        Resource: `${input.kms_key_arn}`,
        Sid: "CaptureKeyUse",
      },
    ],
    Version: "2012-10-17",
  };
}

function bindingExpression(expression, field, expected) {
  if (expression == null) return true;
  return Object.hasOwn(expression, "constant_value")
    ? expression.constant_value === expected
    : Object.keys(expression).length === 1 &&
        Array.isArray(expression.references) &&
        expression.references.length === 1 &&
        expression.references[0] === `var.${field}`;
}
function validateResourceBindings(entry, config, input) {
  const { after, after_unknown: unknown = {} } = entry.change;
  const region = config.expressions.region;
  insist(
    bindingExpression(region, "aws_region", input.aws_region),
    "unreviewed configured resource region",
  );
  if (region != null || after.region != null)
    knownShape(after.region, unknown.region, input.aws_region);
  // AWS6 computes an omitted regional attribute during creation. It is not
  // permission to accept a known foreign region or a configured unknown region.
  const owner = config.expressions.expected_bucket_owner;
  insist(
    owner == null ||
      owner.constant_value === null ||
      bindingExpression(owner, "sandbox_account_id", input.sandbox_account_id),
    "unreviewed expected bucket owner",
  );
  insist(
    unknown.expected_bucket_owner !== true,
    "unknown expected bucket owner",
  );
  if (after.expected_bucket_owner != null)
    strict.equal(after.expected_bucket_owner, input.sandbox_account_id);
}
function hasConfiguredSetting(expression, field) {
  if (expression === null || typeof expression !== "object") return false;
  if (Object.hasOwn(expression, field)) {
    const value = expression[field];
    // Null optional defaults have no operational setting.
    if (
      value != null &&
      !(
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        value.constant_value === null
      )
    )
      return true;
  }
  return Object.values(expression).some((value) =>
    hasConfiguredSetting(value, field),
  );
}
function validateAdditionalStorageControls(entry, config) {
  const { after, after_unknown: unknown = {} } = entry.change;
  if (entry.type === "aws_s3_bucket_versioning") {
    insist(
      !Object.hasOwn(config.expressions, "mfa") &&
        after.mfa == null &&
        !unknown.mfa,
      "MFA credentials are outside the reviewed bootstrap",
    );
    insist(
      !hasConfiguredSetting(
        config.expressions.versioning_configuration,
        "mfa_delete",
      ),
      "configured MFA-delete is outside the reviewed bootstrap",
    );
    const value = after.versioning_configuration[0].mfa_delete;
    insist(
      value == null || value === "Disabled",
      "MFA-delete must remain unconfigured/disabled",
    );
  }
  if (entry.type === "aws_s3_bucket_server_side_encryption_configuration") {
    insist(
      !hasConfiguredSetting(
        config.expressions.rule,
        "blocked_encryption_types",
      ),
      "unreviewed configured encryption controls",
    );
    const blocked = after.rule[0].blocked_encryption_types;
    insist(
      blocked == null ||
        (Array.isArray(blocked) &&
          (blocked.length === 0 ||
            (blocked.length === 1 && blocked[0] === "SSE-C"))),
      "incompatible encryption controls",
    );
  }
}
