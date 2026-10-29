"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  validateScopedPlan,
  assertOtherwiseUnchanged,
  runCli,
} = require("./validate-prerequisite-plan.cjs");
const { hasUnknown } = require("./terraform-meeting-update.cjs");

const routeRewrite = "aws_cloudfront_function.frontend_route_rewrite";
const headersPolicy = "aws_cloudfront_response_headers_policy.crawler_noindex";
const frontend = "aws_cloudfront_distribution.frontend";
const docs = "aws_cloudfront_distribution.docs";
const siteTargets = new Map([
  [routeRewrite, ["create"]],
  [headersPolicy, ["create"]],
  [frontend, ["update"]],
  [docs, ["update"]],
]);
const routeRewriteSource = join(
  __dirname,
  "../../_infra/functions/frontend-route-rewrite.js",
);
// Read-only fields CloudFront refreshes on every distribution update.
const distributionOutputs = [
  "etag",
  "last_modified_time",
  "status",
  "in_progress_validation_batches",
];
const viewerRequest = "viewer-request";

const list = (value) => value ?? [];
const without = (value, keys) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );

// A function ARN is unknown until the new function exists; a known one must match.
function assertAssociation(behavior, mask, functionArn) {
  const [association, ...extra] = list(behavior.function_association);
  assert.equal(extra.length, 0);
  assert.equal(association.event_type, viewerRequest);
  const pending = mask?.function_association?.[0]?.function_arn === true;
  if (!pending) assert.equal(association.function_arn, functionArn);
  assert.deepEqual(list(behavior.lambda_function_association), []);
}

// The one new behavior: same origin, read-only methods, the noindex headers.
function assertNewBehavior(behavior, mask, origin, functionArn) {
  assert.equal(behavior.target_origin_id, origin);
  assert.equal(behavior.viewer_protocol_policy, "redirect-to-https");
  assert.deepEqual([...behavior.allowed_methods].sort(), ["GET", "HEAD"]);
  assert.deepEqual([...behavior.cached_methods].sort(), ["GET", "HEAD"]);
  assert.deepEqual(list(behavior.trusted_key_groups), []);
  assert.deepEqual(list(behavior.trusted_signers), []);
  assertAssociation(behavior, mask, functionArn);
  assert.ok(
    mask?.response_headers_policy_id === true ||
      /^[0-9a-f-]{36}$/.test(behavior.response_headers_policy_id),
  );
  const rest = without(mask ?? {}, [
    "function_association",
    "response_headers_policy_id",
  ]);
  assert.ok(!hasUnknown(rest));
}

function assertOrderedBehaviors(change, newPattern, origin, functionArn) {
  const before = list(change.before.ordered_cache_behavior);
  const after = list(change.after.ordered_cache_behavior);
  const masks = list(change.unknown.ordered_cache_behavior);
  assert.equal(after.length, before.length + 1);
  assert.ok(!before.some((b) => b.path_pattern === newPattern));
  after.forEach((behavior, index) => {
    const existing = before.find(
      (b) => b.path_pattern === behavior.path_pattern,
    );
    if (existing) {
      assert.ok(!hasUnknown(masks[index] ?? false));
      assert.deepEqual(behavior, existing);
    } else {
      assert.equal(behavior.path_pattern, newPattern);
      assertNewBehavior(behavior, masks[index], origin, functionArn);
    }
  });
}

function distributionChange({ before, after, after_unknown: unknown = {} }) {
  assert.ok(before && after);
  return { before, after, unknown };
}

const existingFunction = (change) =>
  change.before.default_cache_behavior[0].function_association[0].function_arn;

function checkDocs(raw) {
  const change = distributionChange(raw);
  assertOtherwiseUnchanged(change, [
    "ordered_cache_behavior",
    ...distributionOutputs,
  ]);
  assertOrderedBehaviors(
    change,
    "/search*",
    "docs-s3",
    existingFunction(change),
  );
}

function checkFrontend(raw, accountId) {
  const change = distributionChange(raw);
  const functionArn = `arn:aws:cloudfront::${accountId}:function/meeting-notes-prod-frontend-route-rewrite`;
  assertOtherwiseUnchanged(change, [
    "custom_error_response",
    "default_cache_behavior",
    "ordered_cache_behavior",
    ...distributionOutputs,
  ]);
  assert.deepEqual(
    list(change.after.custom_error_response).map((r) => [
      Number(r.error_code),
      Number(r.response_code),
      r.response_page_path,
      Number(r.error_caching_min_ttl),
    ]),
    [[403, 404, "/404.html", 0]],
  );
  assert.ok(!hasUnknown(change.unknown.custom_error_response ?? false));
  const [before] = change.before.default_cache_behavior;
  const [after] = change.after.default_cache_behavior;
  const mask = change.unknown.default_cache_behavior?.[0];
  assert.deepEqual(
    without(after, ["function_association"]),
    without(before, ["function_association"]),
  );
  assert.ok(!hasUnknown(without(mask ?? {}, ["function_association"])));
  assertAssociation(after, mask, functionArn);
  assertOrderedBehaviors(change, "/share/*", "frontend-s3", functionArn);
}

function checkRouteRewrite({ after }) {
  assert.equal(after.name, "meeting-notes-prod-frontend-route-rewrite");
  assert.equal(after.runtime, "cloudfront-js-2.0");
  assert.equal(after.publish, true);
  assert.equal(after.code, readFileSync(routeRewriteSource, "utf8"));
}

function checkHeadersPolicy({ after }) {
  assert.equal(after.name, "meeting-notes-prod-crawler-noindex");
  assert.deepEqual(
    after.custom_headers_config[0].items.map((item) => [
      item.header,
      item.value,
    ]),
    [["X-Robots-Tag", "noindex, nofollow"]],
  );
  assert.deepEqual(list(after.cors_config), []);
}

function validateSitePlan(plan, { accountId }) {
  assert.match(accountId, /^\d{12}$/);
  const checks = {
    [routeRewrite]: checkRouteRewrite,
    [headersPolicy]: checkHeadersPolicy,
    [frontend]: (change) => checkFrontend(change, accountId),
    [docs]: checkDocs,
  };
  return validateScopedPlan(plan, {
    targets: siteTargets,
    requiredNoOp: [
      "aws_s3_bucket.frontend",
      "aws_s3_bucket.docs",
      "aws_cloudfront_function.docs_index_rewrite",
    ],
    check: ({ address, change }) => checks[address](change),
  });
}
module.exports = { validateSitePlan, siteTargets };
if (require.main === module)
  runCli(
    (plan) => validateSitePlan(plan, { accountId: process.argv[2] }),
    "Site delivery plan rejected: invalid action evidence or changes outside the site scope.\n",
  );
