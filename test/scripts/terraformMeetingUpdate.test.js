/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { verifyMeetingUpdatePlan } from "../../scripts/deployment/terraform-meeting-update.cjs";
import {
  identity,
  meetingUpdatePlan,
  tableArn,
} from "../fixtures/deployment/terraformMeetingUpdate.js";
test("accepts only the delivery index and exact DescribeTable addition", () => {
  expect(() =>
    verifyMeetingUpdatePlan(meetingUpdatePlan(), identity),
  ).not.toThrow();
});
test("accepts completed state with no effects and reordered JSON object keys", () => {
  const plan = meetingUpdatePlan();
  for (const r of plan.resource_changes) {
    r.change.before = structuredClone(r.change.after);
    r.change.actions = ["no-op"];
  }
  expect(() => verifyMeetingUpdatePlan(plan, identity)).not.toThrow();
});
test.each([
  [
    "wrong account",
    (p) => {
      p.resource_changes[0].change.after.arn = tableArn.replace(
        "123456789012",
        "999999999999",
      );
    },
  ],
  [
    "wrong identity before",
    (p) => {
      p.resource_changes[1].change.before.name = "other";
    },
  ],
  [
    "billing",
    (p) => {
      p.resource_changes[0].change.after.billing_mode = "PROVISIONED";
    },
  ],
  [
    "encryption",
    (p) => {
      p.resource_changes[0].change.after.server_side_encryption = [];
    },
  ],
  [
    "ttl",
    (p) => {
      p.resource_changes[0].change.after.ttl = [
        { enabled: true, attribute_name: "expiresAt" },
      ];
    },
  ],
  [
    "existing index",
    (p) => {
      p.resource_changes[0].change.after.global_secondary_index[0].projection_type =
        "KEYS_ONLY";
    },
  ],
  [
    "duplicate index",
    (p) => {
      p.resource_changes[0].change.after.global_secondary_index.push(
        p.resource_changes[0].change.after.global_secondary_index[1],
      );
    },
  ],
  [
    "duplicate attribute",
    (p) => {
      p.resource_changes[0].change.after.attribute.push({
        name: "updateDeliveryQueue",
        type: "S",
      });
    },
  ],
  [
    "index projection",
    (p) => {
      p.resource_changes[0].change.after.global_secondary_index[1].projection_type =
        "ALL";
    },
  ],
  [
    "index extra setting",
    (p) => {
      p.resource_changes[0].change.after.global_secondary_index[1].warm_throughput =
        [{ read_units_per_second: 12000, write_units_per_second: 4000 }];
    },
  ],
  [
    "policy widening",
    (p) => {
      const d = JSON.parse(p.resource_changes[1].change.after.policy);
      d.Statement[0].Action.push("dynamodb:Scan");
      p.resource_changes[1].change.after.policy = JSON.stringify(d);
    },
  ],
  [
    "another statement",
    (p) => {
      const d = JSON.parse(p.resource_changes[1].change.after.policy);
      d.Statement[1].Resource = ["*"];
      p.resource_changes[1].change.after.policy = JSON.stringify(d);
    },
  ],
  [
    "unknown encryption",
    (p) => {
      p.resource_changes[0].change.after_unknown = {
        server_side_encryption: true,
      };
    },
  ],
  [
    "unknown policy",
    (p) => {
      p.resource_changes[1].change.after_unknown = { policy: true };
    },
  ],
  [
    "unknown future security field",
    (p) => {
      p.resource_changes[0].change.after_unknown = {
        future_security_setting: true,
      };
    },
  ],
  [
    "replacement",
    (p) => {
      p.resource_changes[0].change.actions = ["delete", "create"];
    },
  ],
  [
    "import",
    (p) => {
      p.resource_changes[0].change.importing = { id: "other" };
    },
  ],
  [
    "move",
    (p) => {
      p.resource_changes[0].previous_address = "aws_dynamodb_table.old";
    },
  ],
  [
    "unrelated effect",
    (p) => {
      p.resource_changes.push({
        address: "aws_kms_key.app_general",
        mode: "managed",
        change: {
          actions: ["update"],
          before: {},
          after: {},
          after_unknown: {},
        },
      });
    },
  ],
  [
    "action invocation",
    (p) => {
      p.action_invocations = [{ address: "action.aws_lambda_invoke.extra" }];
    },
  ],
  [
    "existing provisioned capacity",
    (p) => {
      p.resource_changes[0].change.after.global_secondary_index[0].read_capacity = 20;
    },
  ],
  [
    "deferred",
    (p) => {
      p.deferred_changes = [{ reason: "resource_config_unknown" }];
    },
  ],
  [
    "missing target",
    (p) => {
      p.resource_changes.pop();
    },
  ],
  [
    "no-op missing prerequisite",
    (p) => {
      for (const r of p.resource_changes) {
        r.change.after = structuredClone(r.change.before);
        r.change.actions = ["no-op"];
      }
    },
  ],
])("rejects %s", (_, mutate) => {
  const p = meetingUpdatePlan();
  mutate(p);
  expect(() => verifyMeetingUpdatePlan(p, identity)).toThrow();
});
test("rejects the known Sandbox in another region", () => {
  expect(() =>
    verifyMeetingUpdatePlan(meetingUpdatePlan(), {
      ...identity,
      region: "us-west-2",
    }),
  ).toThrow();
});

test("accepts only derived computed unknowns with explicit index keys", () => {
  const p = meetingUpdatePlan();
  p.resource_changes[0].change.after_unknown = {
    global_secondary_index: [
      { read_capacity: true, write_capacity: true, key_schema: true },
      { read_capacity: true, write_capacity: true, key_schema: true },
    ],
    stream_arn: true,
  };
  p.resource_changes[1].change.after_unknown = {
    attachment_count: true,
    policy_id: true,
  };
  expect(() => verifyMeetingUpdatePlan(p, identity)).not.toThrow();
});
test("accepts semantically equivalent JSON policy ordering", () => {
  const p = meetingUpdatePlan(),
    r = p.resource_changes[1];
  const doc = JSON.parse(r.change.after.policy);
  r.change.after.policy = JSON.stringify({
    Statement: doc.Statement.reverse().map((s) => ({
      ...s,
      Action: [...s.Action].reverse(),
      Resource: [...s.Resource].reverse(),
    })),
    Version: doc.Version,
  });
  expect(() => verifyMeetingUpdatePlan(p, identity)).not.toThrow();
});

const historicalMetadata = [
  [
    "data.aws_caller_identity.current",
    "aws_caller_identity",
    "current",
    undefined,
  ],
  [
    "data.aws_route53_zone.frontend_hosted_zone[0]",
    "aws_route53_zone",
    "frontend_hosted_zone",
    0,
  ],
  [
    "data.aws_route53_zone.docs_hosted_zone[0]",
    "aws_route53_zone",
    "docs_hosted_zone",
    0,
  ],
];
function metadataChange(profile, action) {
  const [address, type, name, index] = profile;
  return {
    address,
    type,
    name,
    ...(index === undefined ? {} : { index }),
    mode: "data",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: {
      actions: [action],
      before: action === "read" ? null : { id: "synthetic-metadata" },
      after: { id: "synthetic-metadata" },
      after_unknown: {},
    },
  };
}
test.each(["read", "no-op"])(
  "rejects former metadata sources outside the separated-key closure for %s",
  (action) => {
    const plan = meetingUpdatePlan();
    plan.resource_changes.push(
      ...historicalMetadata.map((profile) => metadataChange(profile, action)),
    );
    expect(() => verifyMeetingUpdatePlan(plan, identity)).toThrow();
  },
);
const invalidMetadata = [
  [
    "missing address",
    (r) => {
      delete r.address;
    },
  ],
  [
    "missing type",
    (r) => {
      delete r.type;
    },
  ],
  [
    "missing name",
    (r) => {
      delete r.name;
    },
  ],
  [
    "missing provider",
    (r) => {
      delete r.provider_name;
    },
  ],
  [
    "external provider",
    (r) => {
      r.provider_name = "registry.terraform.io/hashicorp/external";
    },
  ],
  [
    "spoofed data type",
    (r) => {
      r.type = "aws_secretsmanager_secret_version";
    },
  ],
  [
    "spoofed data name",
    (r) => {
      r.name = "unreviewed";
    },
  ],
  [
    "unapproved AWS read",
    (r) => {
      r.address = "data.aws_region.current";
      r.type = "aws_region";
    },
  ],
  [
    "external data read",
    (r) => {
      r.address = "data.external.unreviewed";
      r.type = "external";
      r.name = "unreviewed";
      r.provider_name = "registry.terraform.io/hashicorp/external";
    },
  ],
  [
    "local file read",
    (r) => {
      r.address = "data.local_file.unreviewed";
      r.type = "local_file";
      r.name = "unreviewed";
      r.provider_name = "registry.terraform.io/hashicorp/local";
    },
  ],
  [
    "secret data read",
    (r) => {
      r.address = "data.aws_secretsmanager_secret_version.unreviewed";
      r.type = "aws_secretsmanager_secret_version";
      r.name = "unreviewed";
    },
  ],
  [
    "module address",
    (r) => {
      r.address = "module.unreviewed." + r.address;
    },
  ],
  [
    "module metadata",
    (r) => {
      r.module_address = "module.unreviewed";
    },
  ],
  [
    "caller identity instance",
    (r) => {
      r.index = 0;
    },
  ],
  [
    "counted caller identity address",
    (r) => {
      r.address += "[0]";
      r.index = 0;
    },
  ],
];
test.each(
  ["read", "no-op"].flatMap((action) =>
    invalidMetadata.map(([reason, mutate]) => [action, reason, mutate]),
  ),
)("rejects %s metadata with %s", (action, _, mutate) => {
  const plan = meetingUpdatePlan(),
    resource = metadataChange(historicalMetadata[0], action);
  mutate(resource);
  plan.resource_changes.push(resource);
  expect(() => verifyMeetingUpdatePlan(plan, identity)).toThrow();
});
test.each(["read", "no-op"])(
  "rejects historical Route53 instance variants for %s",
  (action) => {
    for (const patch of [
      { address: "data.aws_route53_zone.frontend_hosted_zone" },
      { address: "data.aws_route53_zone.frontend_hosted_zone[1]", index: 1 },
      {
        address: 'data.aws_route53_zone.frontend_hosted_zone["0"]',
        index: "0",
      },
      { index: undefined },
      { index: 1 },
      { module_address: "module.unreviewed" },
    ]) {
      const plan = meetingUpdatePlan(),
        resource = {
          ...metadataChange(historicalMetadata[1], action),
          ...patch,
        };
      plan.resource_changes.push(resource);
      expect(() => verifyMeetingUpdatePlan(plan, identity)).toThrow();
    }
  },
);
