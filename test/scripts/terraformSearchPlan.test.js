/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { validateSearchPlan } from "../../scripts/deployment/validate-search-plan.cjs";

const binding = {
  environment: "sandbox",
  region: "us-east-1",
  accountId: "123456789012",
};
const table = "aws_dynamodb_table.meeting_history_table";
const before = {
  name: "meeting-notes-sandbox-MeetingHistoryTable",
  billing_mode: "PAY_PER_REQUEST",
  stream_enabled: false,
  stream_view_type: null,
  stream_arn: null,
  stream_label: null,
};
const resource = (address, after, original = null) => ({
  address,
  mode: "managed",
  change: {
    actions: [original ? "update" : "create"],
    before: original,
    after,
    after_unknown: {},
  },
});
const plan = () => ({
  resource_changes: [
    resource(
      table,
      {
        ...before,
        stream_enabled: true,
        stream_view_type: "NEW_AND_OLD_IMAGES",
      },
      before,
    ),
  ],
});

test("accepts only the additive source stream change", () => {
  expect(validateSearchPlan(plan(), binding).result).toBe("accepted");
});
test.each(["billing_mode", "name"])(
  "refuses unrelated source table mutation: %s",
  (field) => {
    const p = plan();
    p.resource_changes[0].change.after[field] = "changed";
    expect(() => validateSearchPlan(p, binding)).toThrow();
  },
);
test("refuses production and a foreign-account resource", () => {
  expect(() =>
    validateSearchPlan(plan(), { ...binding, environment: "production" }),
  ).toThrow();
  const p = plan();
  p.resource_changes.push(
    resource("aws_s3vectors_vector_bucket.search[0]", {
      vector_bucket_name: "foreign",
      force_destroy: false,
    }),
  );
  expect(() => validateSearchPlan(p, binding)).toThrow();
});
test("refuses unrelated resource changes and replacements", () => {
  const p = plan();
  p.resource_changes.push(resource("aws_iam_role.other", {}));
  expect(() => validateSearchPlan(p, binding)).toThrow();
  const replaced = plan();
  replaced.resource_changes[0].change.actions = ["delete", "create"];
  expect(() => validateSearchPlan(replaced, binding)).toThrow();
});
test("refuses unknown or widened projection permissions", () => {
  for (const policy of [
    undefined,
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["s3vectors:*"], Resource: "*" }],
    }),
  ]) {
    const p = plan();
    p.resource_changes.push(
      resource("aws_iam_role_policy.search_projection[0]", {
        policy,
        role: "meeting-notes-sandbox-search-projection",
        name: "meeting-notes-sandbox-search-projection",
      }),
    );
    expect(() => validateSearchPlan(p, binding)).toThrow();
  }
});

test("accepts coverage-only serving grants and rejects a source-table read", () => {
  const policy = (Resource) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem"], Resource }],
    });
  const p = plan();
  p.resource_changes.push(
    resource("aws_iam_role_policy.search_reader[0]", {
      role: "meeting-notes-sandbox-ecs-task-app-role",
      name: "meeting-notes-sandbox-search-reader",
      policy: policy(
        "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingSearchState",
      ),
    }),
  );
  expect(validateSearchPlan(p, binding).result).toBe("accepted");
  p.resource_changes[1].change.after.policy = policy(
    "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable",
  );
  expect(() => validateSearchPlan(p, binding)).toThrow();
});

test("rejects an unbound stream source", () => {
  const p = plan();
  const mapping = resource(
    "aws_lambda_event_source_mapping.meeting_search[0]",
    {},
  );
  mapping.change.after_unknown = { event_source_arn: true };
  p.resource_changes.push(mapping);
  expect(() => validateSearchPlan(p, binding)).toThrow("dependency evidence");
});
