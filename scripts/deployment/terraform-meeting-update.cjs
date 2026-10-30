"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const {
  verifyModel,
  verifyChecks,
  verifyWarmChange,
} = require("./terraform-meeting-model.cjs");
const tableAddress = "aws_dynamodb_table.meeting_history_table";
const policyAddress = "aws_iam_policy.dynamodb_access_policy";
const tableName = "meeting-notes-sandbox-MeetingHistoryTable";
const policyName = "meeting-notes-sandbox-bot-dynamodb-policy";
const deliveryAttributes = [
  { name: "updateDeliveryQueue", type: "S" },
  { name: "updateDeliveryDueAt", type: "N" },
];
const deliveryIndex = {
  name: "UpdateDeliveryDueIndex",
  hash_key: "updateDeliveryQueue",
  range_key: "updateDeliveryDueAt",
  projection_type: "KEYS_ONLY",
};
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonical).sort().join(",") + "]";
  const members = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    "{" +
    members
      .map(([key, member]) => JSON.stringify(key) + ":" + canonical(member))
      .join(",") +
    "}"
  );
}
function equal(a, b) {
  assert.equal(canonical(a), canonical(b));
}
function named(values) {
  assert.ok(Array.isArray(values));
  const entries = new Map();
  for (const value of values) {
    assert.equal(typeof value.name, "string");
    assert.ok(!entries.has(value.name), "Duplicate member");
    entries.set(value.name, value);
  }
  return entries;
}
function hasUnknown(value) {
  if (value === true) return true;
  if (value === false || value === null) return false;
  assert.ok(value && typeof value === "object", "Malformed unknown mask");
  return Object.values(value).some(hasUnknown);
}
function known(change, ignored = []) {
  const mask = { ...(change.after_unknown ?? {}) };
  for (const field of ignored) delete mask[field];
  assert.ok(!hasUnknown(mask), "Unknown effect");
}
function without(value, fields) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !fields.includes(key)),
  );
}
function validateIndex(index, desired) {
  const core = ["name", "hash_key", "range_key", "projection_type"];
  const neutral = {
    non_key_attributes: [],
    on_demand_throughput: [],
    warm_throughput: [],
  };
  const allowed = [
    ...core,
    ...Object.keys(neutral),
    "key_schema",
    "read_capacity",
    "write_capacity",
  ];
  assert.ok(
    Object.keys(index).every((key) => allowed.includes(key)),
    "Unknown index field",
  );
  for (const [key, empty] of Object.entries(neutral))
    if (desired && index[key] != null) equal(index[key], empty);
  if (index.key_schema?.length)
    equal(index.key_schema, [
      { attribute_name: index.hash_key, key_type: "HASH" },
      ...(index.range_key
        ? [{ attribute_name: index.range_key, key_type: "RANGE" }]
        : []),
    ]);
  for (const key of ["read_capacity", "write_capacity"])
    assert.ok(
      index[key] == null || index[key] === 0,
      "Unexpected index capacity",
    );
  if (desired) {
    equal(
      without(
        index,
        allowed.filter((key) => !core.includes(key)),
      ),
      desired,
    );
  }
}
function neutralWarmThroughput(change) {
  for (const value of [change.before, change.after])
    for (const index of named(value.global_secondary_index).values())
      if (Object.hasOwn(index, "warm_throughput"))
        equal(index.warm_throughput, []);
}

const computedTableFields = ["stream_arn", "stream_label"];
const derivedIndexFields = ["key_schema", "read_capacity", "write_capacity"];
// AWS 6.70 recomputes warm_throughput. With model evidence the plan already
// proved every value neutral, so any mask shape is accepted. Without it, only
// an index whose value is wholly unknown leaves the comparison; a partially
// unknown value stays and is refused, and every other index must keep its
// warm_throughput exactly, since a pre-warm change is billed.
// Returns whether this index's warm_throughput is wholly unknown.
function clearWarmMask(indexMask, computedWarm) {
  const warm = indexMask.warm_throughput;
  if (computedWarm && Object.hasOwn(indexMask, "warm_throughput")) {
    assert.ok(
      warm === true ||
        warm === false ||
        (Array.isArray(warm) && warm.length === 0),
      "Malformed warm throughput mask",
    );
    delete indexMask.warm_throughput;
    return false;
  }
  if (warm !== true) return false;
  delete indexMask.warm_throughput;
  return true;
}
// Returns the names of the indexes whose warm_throughput is wholly unknown.
function knownTableEffects(change, computedWarm) {
  // AWS 6.69.1 computes these read-only fields. Explicit hash/range keys bind
  // key_schema, and PAY_PER_REQUEST makes provisioned capacity inapplicable.
  const mask = structuredClone(change.after_unknown ?? {});
  for (const field of computedTableFields) delete mask[field];
  const unknownWarm = new Set();
  if (Array.isArray(mask.global_secondary_index)) {
    assert.equal(
      mask.global_secondary_index.length,
      change.after.global_secondary_index.length,
    );
    mask.global_secondary_index.forEach((indexMask, i) => {
      assert.ok(indexMask && typeof indexMask === "object");
      const index = change.after.global_secondary_index[i];
      for (const key of derivedIndexFields) delete indexMask[key];
      if (clearWarmMask(indexMask, computedWarm)) unknownWarm.add(index.name);
      assert.ok(!hasUnknown(indexMask), "Unknown index effect");
      validateIndex(index);
    });
    delete mask.global_secondary_index;
  }
  assert.ok(!hasUnknown(mask), "Unknown table effect");
  return unknownWarm;
}

// The table may change only by gaining `index` and its key attributes; the
// processing-retry scope shares this comparison for its own index.
function tableDelta(change, { name, arn, attributes: added, index }, evidence) {
  const computedWarm = evidence !== undefined;
  if (computedWarm) {
    verifyWarmChange(change, evidence);
    neutralWarmThroughput(change);
  }
  for (const value of [change.before, change.after]) {
    assert.equal(value.name, name);
    assert.equal(value.id, name);
    assert.equal(value.arn, arn);
    assert.equal(value.billing_mode, "PAY_PER_REQUEST");
    if (value.region != null) assert.equal(value.region, "us-east-1");
    named(value.attribute);
    for (const index of named(value.global_secondary_index).values())
      validateIndex(index);
  }
  const unknownWarm = knownTableEffects(change, computedWarm);
  const expected = structuredClone(change.before);
  const attributes = named(expected.attribute);
  for (const attribute of added) {
    if (attributes.has(attribute.name))
      equal(attributes.get(attribute.name), attribute);
    else expected.attribute.push(attribute);
  }
  const desired = named(change.after.global_secondary_index).get(index.name);
  assert.ok(desired, `Missing ${index.name}`);
  validateIndex(desired, index);
  const indexes = named(expected.global_secondary_index);
  if (indexes.has(desired.name))
    validateIndex(indexes.get(desired.name), index);
  else expected.global_secondary_index.push(desired);
  const normalize = (value) => {
    const normalized = without(value, computedTableFields);
    normalized.global_secondary_index = value.global_secondary_index.map(
      (index) =>
        without(index, [
          ...derivedIndexFields,
          ...(computedWarm || unknownWarm.has(index.name)
            ? ["warm_throughput"]
            : []),
        ]),
    );
    return normalized;
  };
  equal(normalize(expected), normalize(change.after));
}
function policyDelta(change, tableArn, accountId) {
  const arn = `arn:aws:iam::${accountId}:policy/${policyName}`;
  const computed = ["attachment_count", "policy_id"];
  known(change, computed);
  for (const value of [change.before, change.after]) {
    assert.equal(value.name, policyName);
    assert.equal(value.id, arn);
    assert.equal(value.arn, arn);
  }
  const before = JSON.parse(change.before.policy),
    after = JSON.parse(change.after.policy);
  const statements = before.Statement.filter(
    (s) => s.Sid === "DescribeSubscriptionReadiness",
  );
  assert.equal(statements.length, 1);
  const statement = statements[0];
  assert.equal(statement.Effect, "Allow");
  equal([statement.Action].flat(), ["dynamodb:DescribeTable"]);
  assert.ok(Array.isArray(statement.Resource));
  assert.equal(new Set(statement.Resource).size, statement.Resource.length);
  if (!statement.Resource.includes(tableArn)) statement.Resource.push(tableArn);
  equal(before, after);
  equal(
    without(change.before, ["policy", ...computed]),
    without(change.after, ["policy", ...computed]),
  );
}
function verifyResource(resource, arn, accountId, evidence) {
  assert.equal(resource.previous_address, undefined, "Moved resource");
  const change = resource.change;
  assert.ok(
    change && !change.importing && !resource.importing,
    "Imported resource",
  );
  equal(change.replace_paths ?? [], []);
  // The separated-key two-target closure contains no Terraform data sources.
  assert.equal(resource.mode, "managed");
  assert.equal(change.actions.length, 1);
  assert.ok(["update", "no-op"].includes(change.actions[0]));
  assert.ok(change.before && change.after);
  if ([tableAddress, policyAddress].includes(resource.address)) {
    assert.equal(resource.provider_name, "registry.terraform.io/hashicorp/aws");
    assert.equal(resource.type, resource.address.split(".")[0]);
    assert.equal(resource.name, resource.address.split(".")[1]);
    if (resource.address === tableAddress) {
      neutralWarmThroughput(change);
      tableDelta(
        change,
        {
          name: tableName,
          arn,
          attributes: deliveryAttributes,
          index: deliveryIndex,
        },
        evidence,
      );
    } else policyDelta(change, arn, accountId);
  } else {
    assert.equal(change.actions[0], "no-op", "Unrelated managed effect");
    known(change);
    equal(change.before, change.after);
  }
  if (change.actions[0] === "no-op") {
    const normalize = (value) =>
      resource.address === tableAddress && evidence !== undefined
        ? {
            ...value,
            global_secondary_index: value.global_secondary_index.map((index) =>
              without(index, ["warm_throughput"]),
            ),
          }
        : value;
    equal(normalize(change.before), normalize(change.after));
  }
}
function verifyMeetingUpdatePlan(plan, identity, evidence) {
  const { accountId } = z
    .object({
      accountId: z.string().regex(/^\d{12}$/),
      region: z.literal("us-east-1"),
    })
    .strict()
    .parse(identity);
  assert.ok(plan && typeof plan === "object");
  assert.equal(plan.format_version, "1.2");
  assert.notEqual(plan.errored, true);
  equal(plan.deferred_changes ?? [], []);
  equal(plan.action_invocations ?? [], []);
  assert.ok(Array.isArray(plan.resource_changes));
  if (evidence !== undefined) verifyModel(plan, evidence);
  verifyChecks(plan, evidence);
  const found = new Set();
  const arn = `arn:aws:dynamodb:us-east-1:${accountId}:table/${tableName}`;
  for (const resource of plan.resource_changes) {
    assert.ok(!found.has(resource.address), "Duplicate address");
    found.add(resource.address);
    verifyResource(resource, arn, accountId, evidence);
  }
  assert.ok(
    found.has(tableAddress) && found.has(policyAddress),
    "Missing target state",
  );
}
module.exports = {
  verifyMeetingUpdatePlan,
  hasUnknown,
  named,
  validateIndex,
  tableDelta,
  deliveryIndex,
  without,
};
