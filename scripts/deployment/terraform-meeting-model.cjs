"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readdirSync, readFileSync, lstatSync } = require("node:fs");
const { join } = require("node:path");
const { bindingHash } = require("./binding-hash.cjs");
const { digest } = require("./collector-payload.cjs");
// Source audit and maintenance contract: docs/terraform-meeting-source-model.md.
const sourceModel =
  "00044f24f1f1371c8a022ab64cde537cbcb7e319ea7fde4059592f89cf839857";
const awsProvider = "registry.terraform.io/hashicorp/aws";
const tableAddress = "aws_dynamodb_table.meeting_history_table";
const resourceChecks = [
  "aws_cloudfront_distribution.docs",
  "aws_cloudfront_distribution.frontend",
  "aws_elasticache_replication_group.redis",
  "aws_iam_policy.site_publishing",
  "aws_iam_role.production_acceptance_collector",
  "aws_iam_role.production_deploy",
  "aws_iam_role.production_introduction",
  "aws_iam_role.sandbox_deploy",
  "aws_iam_role_policy.production_launcher_reads",
];
const variableChecks = [
  "ECS_DESIRED_COUNT",
  "ENABLE_API_ALB",
  "docs_distribution_id",
  "frontend_distribution_id",
  "grafana_token_rotation_days",
  "production_acceptance_fixtures",
  "production_introduction_reviewed_policy_arns",
  "production_introduction_route_role_arns",
  "production_introduction_standalone_tasks",
  "production_introduction_task_definitions",
];
const tables = [
  "access_logs",
  "active_meeting",
  "ask_conversation",
  "auto_record_settings",
  "channel_context",
  "chat_tts_usage",
  "config_overrides",
  "contact_feedback",
  "deployment_control",
  "dictionary",
  "entitlement_grant",
  "feedback",
  "guild_subscription",
  "installer",
  "interaction_receipt",
  "mcp_oauth",
  "meeting_control_command",
  "meeting_history",
  "meeting_share",
  "meeting_user_index",
  "notion_integration",
  "onboarding_state",
  "payment_transaction",
  "personal_media_upload_job",
  "personal_recording_segment",
  "recording_transcript",
  "server_context",
  "session",
  "stripe_webhook_event",
  "user_speech_settings",
];
const closure = [
  ...tables.map((name) => `aws_dynamodb_table.${name}_table`),
  "aws_iam_policy.dynamodb_access_policy",
  "aws_kms_key.app_general",
];
const excludedChecks = [
  ...resourceChecks.map((address) => {
    const [type, name] = address.split(".");
    return {
      kind: "resource",
      mode: "managed",
      type,
      name,
      to_display: address,
    };
  }),
  ...variableChecks.map((name) => ({
    kind: "var",
    name,
    to_display: `var.${name}`,
  })),
];
const proofs = new WeakMap();
const verifiedChanges = new WeakMap();
const isSource = (name) =>
  /\.tf(?:\.json)?$/.test(name) || name === ".terraform.lock.hcl";
const modelDigest = (bytes) =>
  digest(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")));

function verifySource(directory, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, windowsHide: true });
  assert.equal(
    git("rev-parse", "HEAD").toString().trim(),
    sourceSha,
    "Checkout source mismatch",
  );
  const committed = git("ls-tree", "--name-only", `${sourceSha}:_infra`)
    .toString()
    .trim()
    .split("\n")
    .filter(isSource)
    .sort();
  const current = Array.from(readdirSync(join(directory, "_infra")))
    .filter(isSource)
    .sort();
  assert.deepEqual(current, committed, "Terraform source inventory changed");
  const manifest = {};
  for (const name of current) {
    const path = join(directory, "_infra", name);
    assert.ok(lstatSync(path).isFile(), "Indirect Terraform source");
    manifest[name] = modelDigest(readFileSync(path));
    assert.equal(
      manifest[name],
      modelDigest(git("show", `${sourceSha}:_infra/${name}`)),
      "Terraform source differs from producer",
    );
  }
  assert.equal(
    bindingHash(manifest),
    sourceModel,
    "Unaudited Terraform source model",
  );
  return sourceModel;
}

// Called only after native invocation verification (and bundle/source-relation
// verification on Apply), using that invocation's checkout and command records.
function meetingModelEvidence(
  plan,
  { directory, sourceSha, output, lockfileSha256 },
) {
  assert.equal(
    digest(readFileSync(join(directory, "_infra/.terraform.lock.hcl"))),
    lockfileSha256,
    "Raw lock changed",
  );
  const init = output.findLastIndex(
    (r) =>
      r.command === "terraform" &&
      JSON.stringify(r.args) ===
        JSON.stringify([
          "-chdir=_infra",
          "init",
          "-input=false",
          "-lockfile=readonly",
        ]) &&
      r.outcome === "exited" &&
      r.exitCode === 0,
  );
  assert.ok(init >= 0, "Missing readonly provider installation");
  const version = output
    .slice(init + 1)
    .find(
      (r) =>
        r.command === "terraform" &&
        JSON.stringify(r.args) ===
          JSON.stringify(["-chdir=_infra", "version", "-json"]) &&
        r.outcome === "exited" &&
        r.exitCode === 0,
    );
  assert.ok(version, "Missing post-init installed-provider version");
  const installed = JSON.parse(
    Buffer.from(version.stdout, "base64").toString(),
  );
  assert.equal(installed.terraform_version, "1.17.1");
  assert.equal(plan.terraform_version, installed.terraform_version);
  assert.equal(installed.provider_selections?.[awsProvider], "6.69.1");
  verifySource(directory, sourceSha);
  const token = {};
  proofs.set(token, bindingHash(plan));
  return token;
}

function verifyModel(plan, token) {
  assert.equal(
    proofs.get(token),
    bindingHash(plan),
    "Missing exact-plan source/provider proof",
  );
  assert.deepEqual(
    plan.resource_changes.map((r) => r.address).sort(),
    [...closure].sort(),
    "Unaudited dependency closure",
  );
  for (const r of plan.resource_changes) {
    assert.equal(r.mode, "managed");
    assert.equal(r.provider_name, awsProvider);
    assert.equal(r.type, r.address.split(".")[0]);
    assert.equal(r.name, r.address.split(".")[1]);
  }
  assert.equal(
    plan.variables?.ENABLE_PROCESSING_RETRY_INDEX?.value,
    false,
    "Retry index must be explicitly disabled",
  );
  const root = plan.configuration?.root_module;
  assert.ok(root && !root.module_calls, "Missing or indirect configuration");
  const matches = root.resources?.filter((r) => r.address === tableAddress);
  assert.equal(matches?.length, 1, "Missing or duplicate table configuration");
  const resource = matches[0];
  assert.equal(resource.provider_config_key, "aws");
  assert.equal(resource.mode, "managed");
  assert.equal(resource.type, "aws_dynamodb_table");
  assert.equal(resource.name, "meeting_history_table");
  assert.equal(resource.dynamic, undefined);
  assert.equal(resource.count_expression, undefined);
  assert.equal(resource.for_each_expression, undefined);
  const expressions = resource.expressions;
  assert.deepEqual(expressions.billing_mode, {
    constant_value: "PAY_PER_REQUEST",
  });
  assert.equal(expressions.dynamic, undefined);
  const expected = [
    {
      name: "GuildTimestampIndex",
      hash_key: "guildId",
      range_key: "timestamp",
      projection_type: "ALL",
    },
    {
      name: "UpdateDeliveryDueIndex",
      hash_key: "updateDeliveryQueue",
      range_key: "updateDeliveryDueAt",
      projection_type: "KEYS_ONLY",
    },
  ];
  assert.ok(Array.isArray(expressions.global_secondary_index));
  const blocks = expressions.global_secondary_index.map((block) => {
    assert.deepEqual(
      Object.keys(block).sort(),
      Object.keys(expected[0]).sort(),
      "Configured index capacity or dynamic expression",
    );
    return Object.fromEntries(
      Object.entries(block).map(([key, expression]) => {
        assert.deepEqual(Object.keys(expression), ["constant_value"]);
        assert.equal(typeof expression.constant_value, "string");
        return [key, expression.constant_value];
      }),
    );
  });
  assert.deepEqual(
    blocks.sort((a, b) => a.name.localeCompare(b.name)),
    expected,
  );
  const table = plan.resource_changes.find((r) => r.address === tableAddress);
  const core = (index) =>
    Object.fromEntries(
      Object.keys(expected[0]).map((key) => [key, index[key]]),
    );
  assert.deepEqual(
    table.change.after.global_secondary_index
      .map(core)
      .sort((a, b) => a.name.localeCompare(b.name)),
    expected,
  );
  verifiedChanges.set(token, bindingHash(table.change));
}

function verifyWarmChange(change, token) {
  assert.equal(
    verifiedChanges.get(token),
    bindingHash(change),
    "Missing validated GSI configuration proof",
  );
}

function verifyChecks(plan, evidence) {
  if (Object.hasOwn(plan, "checks")) assert.ok(Array.isArray(plan.checks));
  const seen = new Set();
  for (const check of plan.checks ?? []) {
    const address = check.address;
    assert.ok(
      address && !seen.has(address.to_display),
      "Missing or duplicate check identity",
    );
    seen.add(address.to_display);
    assert.ok(
      ["pass", "unknown"].includes(check.status),
      "Failed or unsupported check",
    );
    assert.ok(
      Object.keys(check).every((k) =>
        ["address", "status", "instances"].includes(k),
      ),
    );
    const excluded = excludedChecks.find(
      (c) => c.to_display === address.to_display,
    );
    if (excluded) assert.deepEqual(address, excluded);
    else if (address.kind === "resource") {
      assert.ok(closure.includes(address.to_display), "Unknown check address");
      const [type, name] = address.to_display.split(".");
      assert.deepEqual(address, {
        kind: "resource",
        mode: "managed",
        type,
        name,
        to_display: address.to_display,
      });
    } else {
      assert.ok(
        [
          "project_name",
          "environment",
          "aws_region",
          "ENABLE_PROCESSING_RETRY_INDEX",
        ].includes(address.name),
        "Unknown check address",
      );
      assert.deepEqual(address, {
        kind: "var",
        name: address.name,
        to_display: `var.${address.name}`,
      });
    }
    if (check.status === "unknown") {
      assert.ok(evidence && excluded, "Relevant unknown check");
      assert.equal(check.instances, undefined, "Unknown check instances");
      if (address.kind === "resource")
        assert.ok(
          !plan.resource_changes.some(
            (r) =>
              r.address === address.to_display ||
              r.address.startsWith(`${address.to_display}[`),
          ),
          "Excluded resource is included",
        );
    } else if (check.instances !== undefined) {
      assert.ok(Array.isArray(check.instances));
      const instances = new Set();
      for (const instance of check.instances) {
        assert.equal(instance.status, "pass");
        assert.ok(
          Object.keys(instance).every((key) =>
            ["address", "status", "problems"].includes(key),
          ),
        );
        assert.deepEqual(instance.problems ?? [], []);
        const item = instance.address;
        assert.ok(item && typeof item.to_display === "string");
        assert.ok(
          Object.keys(item).every((key) =>
            ["to_display", "instance_key"].includes(key),
          ),
        );
        const suffix = Object.hasOwn(item, "instance_key")
          ? `[${JSON.stringify(item.instance_key)}]`
          : "";
        if (suffix)
          assert.ok(
            typeof item.instance_key === "string" ||
              (Number.isSafeInteger(item.instance_key) &&
                item.instance_key >= 0),
          );
        assert.equal(item.to_display, address.to_display + suffix);
        assert.ok(!instances.has(item.to_display), "Duplicate check instance");
        instances.add(item.to_display);
      }
    }
  }
}
module.exports = {
  meetingModelEvidence,
  verifyModel,
  verifyChecks,
  verifySource,
  verifyWarmChange,
  closure,
  excludedChecks,
};
