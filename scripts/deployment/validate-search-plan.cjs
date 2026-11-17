"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  assertOtherwiseUnchanged,
} = require("./validate-prerequisite-plan.cjs");
const { hasUnknown } = require("./terraform-meeting-update.cjs");

const source = "aws_dynamodb_table.meeting_history_table";
const names = [
  "aws_s3vectors_vector_bucket.search",
  "aws_s3vectors_index.search",
  "aws_dynamodb_table.meeting_search_state",
  "aws_iam_role_policy.search_reader",
  "aws_sqs_queue.search_failures",
  "aws_iam_role.search_projection",
  "aws_iam_role_policy.search_projection",
  "aws_cloudwatch_log_group.search_projection",
  "aws_lambda_function.search_projection",
  "aws_lambda_event_source_mapping.meeting_search",
  "aws_cloudwatch_event_rule.search_reconcile",
  "aws_cloudwatch_event_target.search_reconcile",
  "aws_lambda_permission.search_reconcile",
];
const searchTargets = new Map(
  [...names, source].map((name) => [name, ["create", "update"]]),
);
const list = (value) => (Array.isArray(value) ? value : [value]);
const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());

function validateSearchPlan(plan, binding) {
  assert.equal(binding.environment, "sandbox");
  assert.equal(binding.region, "us-east-1");
  assert.match(binding.accountId, /^\d{12}$/);
  const prefix = "meeting-notes-sandbox";
  const arn = (service, suffix) =>
    `arn:aws:${service}:us-east-1:${binding.accountId}:${suffix}`;
  const bucket = `${prefix}-search-${binding.accountId}`;
  const bucketArn = arn("s3vectors", `bucket/${bucket}`);
  const stateArn = arn("dynamodb", `table/${prefix}-MeetingSearchState`);
  const sourceArn = arn("dynamodb", `table/${prefix}-MeetingHistoryTable`);
  const queueArn = arn("sqs", `${prefix}-search-failures`);
  const logArn = arn(
    "logs",
    `log-group:/aws/lambda/${prefix}-search-projection`,
  );
  const functionArn = arn("lambda", `function:${prefix}-search-projection`);
  const targets = new Map([[source, ["update"]]]);
  for (const resource of plan.resource_changes) {
    const match =
      /^(.*)\[(0|"(?:meetings|transcripts)-[a-z0-9][a-z0-9-]{0,31}")\]$/.exec(
        resource.address,
      );
    if (!match || !names.includes(match[1])) continue;
    assert.equal(match[1] === "aws_s3vectors_index.search", match[2] !== "0");
    targets.set(resource.address, [
      "create",
      ...([
        "aws_iam_role_policy.search_reader",
        "aws_iam_role_policy.search_projection",
        "aws_lambda_function.search_projection",
      ].includes(match[1])
        ? ["update"]
        : []),
    ]);
  }
  const valueAt = (address) =>
    plan.resource_changes.find((r) => r.address === address)?.change.after;
  const bound = (resource, field, expected, dependency) => {
    if (!hasUnknown(resource.change.after_unknown?.[field] ?? false)) {
      assert.equal(resource.change.after[field], expected);
      return;
    }
    const base = resource.address.replace(/\[.*\]$/, "");
    const refs = plan.configuration?.root_module?.resources?.find(
      (entry) => entry.address === base,
    )?.expressions?.[field]?.references;
    assert.ok(refs?.length, `Missing ${field} dependency evidence`);
    assert.ok(
      refs.every(
        (ref) =>
          ref === dependency ||
          ref.startsWith(`${dependency}.`) ||
          ref.startsWith(`${dependency}[`),
      ),
    );
  };
  const keyArn = valueAt("aws_kms_key.app_general")?.arn;
  const secretArn = valueAt("aws_secretsmanager_secret.openai_api_key")?.arn;
  const langfusePublicArn = valueAt(
    "aws_secretsmanager_secret.langfuse_public_key",
  )?.arn;
  const langfuseSecretArn = valueAt(
    "aws_secretsmanager_secret.langfuse_secret_key",
  )?.arn;
  const transcriptBucket = valueAt("aws_s3_bucket.transcripts")?.arn;
  const indexes = plan.resource_changes
    .filter((r) => r.address.startsWith("aws_s3vectors_index.search["))
    .map(
      (r) =>
        `${bucketArn}/index/${JSON.parse(r.address.slice(r.address.indexOf("[") + 1, -1))}`,
    );
  const resourcesFor = {
    "s3vectors:GetIndex": indexes,
    "s3vectors:QueryVectors": indexes,
    "s3vectors:GetVectors": indexes,
    "s3vectors:PutVectors": indexes,
    "s3vectors:DeleteVectors": indexes,
    "s3vectors:ListVectors": indexes,
    "dynamodb:BatchGetItem": [stateArn],
    "dynamodb:GetItem": [
      sourceArn,
      stateArn,
      `${stateArn}/index/ProjectionMeetingIndex`,
    ],
    "dynamodb:Scan": [
      sourceArn,
      stateArn,
      `${stateArn}/index/ProjectionMeetingIndex`,
    ],
    "dynamodb:PutItem": [stateArn, `${stateArn}/index/ProjectionMeetingIndex`],
    "dynamodb:UpdateItem": [
      stateArn,
      `${stateArn}/index/ProjectionMeetingIndex`,
    ],
    "dynamodb:DeleteItem": [
      stateArn,
      `${stateArn}/index/ProjectionMeetingIndex`,
    ],
    "dynamodb:Query": [stateArn, `${stateArn}/index/ProjectionMeetingIndex`],
    "dynamodb:DescribeStream": [`${sourceArn}/stream/*`],
    "dynamodb:GetRecords": [`${sourceArn}/stream/*`],
    "dynamodb:GetShardIterator": [`${sourceArn}/stream/*`],
    "dynamodb:ListStreams": [`${sourceArn}/stream/*`],
    "s3:GetObject": transcriptBucket ? [`${transcriptBucket}/*`] : [],
    "secretsmanager:GetSecretValue": [
      secretArn,
      langfusePublicArn,
      langfuseSecretArn,
    ].filter(Boolean),
    "kms:Decrypt": keyArn ? [keyArn] : [],
    "kms:GenerateDataKey": keyArn ? [keyArn] : [],
    "sqs:SendMessage": [queueArn],
    "logs:CreateLogStream": [`${logArn}:*`],
    "logs:PutLogEvents": [`${logArn}:*`],
  };
  function policy(resource) {
    assert.ok(!hasUnknown(resource.change.after_unknown?.policy ?? false));
    const parsed = JSON.parse(resource.change.after.policy);
    assert.deepEqual(Object.keys(parsed).sort(), ["Statement", "Version"]);
    assert.equal(parsed.Version, "2012-10-17");
    assert.ok(parsed.Statement.length > 0);
    const reader = resource.address.startsWith(
      "aws_iam_role_policy.search_reader",
    );
    assert.equal(
      resource.change.after.role,
      reader ? `${prefix}-ecs-task-app-role` : `${prefix}-search-projection`,
    );
    assert.equal(
      resource.change.after.name,
      reader ? `${prefix}-search-reader` : `${prefix}-search-projection`,
    );
    assert.ok(!resource.change.after.name_prefix);
    for (const statement of parsed.Statement) {
      assert.deepEqual(Object.keys(statement).sort(), [
        "Action",
        "Effect",
        "Resource",
      ]);
      assert.equal(statement.Effect, "Allow");
      for (const action of list(statement.Action)) {
        if (reader)
          assert.ok(
            [
              "s3vectors:GetIndex",
              "s3vectors:QueryVectors",
              "s3vectors:GetVectors",
              "dynamodb:GetItem",
              "dynamodb:BatchGetItem",
            ].includes(action),
          );
        const allowed = resourcesFor[action];
        assert.ok(allowed?.length, `Unapproved search action ${action}`);
        for (const target of list(statement.Resource)) {
          assert.ok(
            allowed.includes(target),
            `Unapproved search resource ${target}`,
          );
          if (reader && action.startsWith("dynamodb:"))
            assert.equal(target, stateArn);
        }
      }
    }
  }
  return validateScopedPlan(plan, {
    targets,
    requiredNoOp: [],
    check(resource) {
      const after = resource.change.after;
      const address = resource.address;
      if (address === source) {
        assert.equal(after.name, `${prefix}-MeetingHistoryTable`);
        assert.equal(after.stream_enabled, true);
        assert.equal(after.stream_view_type, "NEW_AND_OLD_IMAGES");
        assertOtherwiseUnchanged(
          {
            before: resource.change.before,
            after,
            unknown: resource.change.after_unknown ?? {},
          },
          ["stream_enabled", "stream_view_type", "stream_arn", "stream_label"],
        );
      } else if (address.startsWith("aws_iam_role_policy.")) {
        policy(resource);
      } else if (address.startsWith("aws_s3vectors_vector_bucket.")) {
        assert.equal(after.vector_bucket_name, bucket);
        assert.equal(after.force_destroy, false);
        assert.equal(after.encryption_configuration[0].sse_type, "AES256");
        assert.ok(!after.encryption_configuration[0].kms_key_arn);
      } else if (address.startsWith("aws_s3vectors_index.")) {
        assert.equal(after.vector_bucket_name, bucket);
        assert.match(
          after.index_name,
          /^(meetings|transcripts)-[a-z0-9][a-z0-9-]{0,31}$/,
        );
        assert.equal(after.dimension, 1536);
        assert.equal(after.data_type, "float32");
        assert.equal(after.distance_metric, "cosine");
        assert.deepEqual(after.metadata_configuration, [
          { non_filterable_metadata_keys: ["search_text"] },
        ]);
      } else if (
        address.startsWith("aws_dynamodb_table.meeting_search_state")
      ) {
        assert.equal(after.name, `${prefix}-MeetingSearchState`);
        assert.equal(after.hash_key, "projectionId");
        assert.equal(after.billing_mode, "PAY_PER_REQUEST");
        assert.equal(after.point_in_time_recovery[0].enabled, true);
        assert.equal(after.server_side_encryption[0].enabled, true);
        assert.equal(after.server_side_encryption[0].kms_key_arn, keyArn);
      } else if (address.startsWith("aws_iam_role.search_projection")) {
        assert.equal(after.name, `${prefix}-search-projection`);
        assert.deepEqual(JSON.parse(after.assume_role_policy), {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        });
        assert.ok(
          !after.managed_policy_arns?.length && !after.inline_policy?.length,
        );
      } else if (address.startsWith("aws_sqs_queue.")) {
        assert.equal(after.name, `${prefix}-search-failures`);
        assert.equal(after.message_retention_seconds, 1209600);
        assert.equal(after.kms_master_key_id, keyArn);
        assert.ok(!after.policy);
      } else if (address.startsWith("aws_cloudwatch_log_group.")) {
        assert.equal(after.name, `/aws/lambda/${prefix}-search-projection`);
        assert.equal(after.retention_in_days, 365);
        assert.equal(after.kms_key_id, keyArn);
      } else if (address.startsWith("aws_lambda_function.")) {
        assert.equal(after.function_name, `${prefix}-search-projection`);
        assert.equal(after.handler, "main.handler");
        assert.equal(after.runtime, "nodejs24.x");
        assert.equal(
          after.role,
          `arn:aws:iam::${binding.accountId}:role/${prefix}-search-projection`,
        );
        assert.equal(after.reserved_concurrent_executions, 2);
        assert.equal(after.timeout, 300);
        assert.equal(after.memory_size, 1024);
        assert.deepEqual(after.dead_letter_config, [{ target_arn: queueArn }]);
        assert.ok(after.filename.endsWith("/search_projection.zip"));
        assert.ok(!after.vpc_config?.length && !after.layers?.length);
        const env = after.environment[0].variables;
        assert.equal(env.OPENAI_API_KEY_SECRET_ARN, secretArn);
        assert.equal(env.LANGFUSE_PUBLIC_KEY_SECRET_ARN, langfusePublicArn);
        assert.equal(env.LANGFUSE_SECRET_KEY_SECRET_ARN, langfuseSecretArn);
        assert.equal(env.LANGFUSE_TRACING_ENVIRONMENT, "sandbox");
        assert.ok(
          !Object.keys(env).some((key) =>
            /TOKEN|PASSWORD|SECRET$|API_KEY$/.test(key),
          ),
        );
      } else if (address.startsWith("aws_lambda_event_source_mapping.")) {
        if (
          hasUnknown(resource.change.after_unknown?.event_source_arn ?? false)
        ) {
          bound(resource, "event_source_arn", null, source);
        } else {
          assert.ok(after.event_source_arn.startsWith(`${sourceArn}/stream/`));
        }
        bound(
          resource,
          "function_name",
          functionArn,
          "aws_lambda_function.search_projection",
        );
        assert.equal(after.starting_position, "TRIM_HORIZON");
        assert.equal(after.batch_size, 10);
        assert.equal(after.maximum_record_age_in_seconds, 21600);
        assert.equal(after.maximum_retry_attempts, 10);
        assert.deepEqual(after.destination_config, [
          { on_failure: [{ destination_arn: queueArn }] },
        ]);
        sameSet(after.function_response_types, ["ReportBatchItemFailures"]);
        assert.equal(after.bisect_batch_on_function_error, true);
      } else if (address.startsWith("aws_cloudwatch_event_rule.")) {
        assert.equal(after.name, `${prefix}-search-reconcile`);
        assert.equal(after.schedule_expression, "rate(5 minutes)");
      } else if (address.startsWith("aws_cloudwatch_event_target.")) {
        assert.deepEqual(JSON.parse(after.input), { reconcile: true });
        assert.equal(after.rule, `${prefix}-search-reconcile`);
        bound(
          resource,
          "arn",
          functionArn,
          "aws_lambda_function.search_projection",
        );
      } else if (address.startsWith("aws_lambda_permission.")) {
        assert.equal(after.action, "lambda:InvokeFunction");
        assert.equal(after.principal, "events.amazonaws.com");
        assert.equal(after.function_name, `${prefix}-search-projection`);
        bound(
          resource,
          "source_arn",
          arn("events", `rule/${prefix}-search-reconcile`),
          "aws_cloudwatch_event_rule.search_reconcile",
        );
      }
    },
  });
}
module.exports = { searchTargets, validateSearchPlan };
