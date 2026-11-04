/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { siteAccountId, sitePlan } from "../fixtures/deployment/sitePlan.js";
import {
  dropResource,
  findChange,
  forceUpdate,
  markAllNoOp,
  runPlanGuard,
  siteGuard,
} from "../fixtures/deployment/planGuard.js";

type Plan = ReturnType<typeof sitePlan>;
type Change = Plan["resource_changes"][number];
type Values = Record<string, unknown> & {
  ordered_cache_behavior: Record<string, unknown>[];
  default_cache_behavior: Record<string, unknown>[];
  custom_error_response: Record<string, unknown>[];
};
type Mutable = { after: Values; after_unknown: Record<string, unknown> };

const frontend = "aws_cloudfront_distribution.frontend";
const docs = "aws_cloudfront_distribution.docs";
const routeRewrite = "aws_cloudfront_function.frontend_route_rewrite";
const headers = "aws_cloudfront_response_headers_policy.crawler_noindex";

const validate = (input: unknown, account = siteAccountId) =>
  runPlanGuard(siteGuard, JSON.stringify(input), [account]);
const find = (plan: Plan, address: string): Change => findChange(plan, address);
const change = (plan: Plan, address: string) =>
  find(plan, address).change as unknown as Mutable;
function rejected(mutate: (plan: Plan) => void) {
  const plan = sitePlan();
  mutate(plan);
  const result = validate(plan);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Site delivery plan rejected");
}

test("accepts the two creates and both distribution routing updates", () => {
  const result = validate(sitePlan());
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).changes).toHaveLength(4);
});

test("accepts an already delivered scope as no-ops", () => {
  expect(validate(markAllNoOp(sitePlan())).status).toBe(0);
});

test.each([
  [frontend, ["delete", "create"]],
  [docs, ["create"]],
  [routeRewrite, ["update"]],
  [headers, ["delete"]],
])("rejects %s with actions %j", (address, actions) =>
  rejected((plan) => {
    find(plan, address).change.actions = actions;
  }),
);

test.each([
  "aws_kms_key.app_general",
  "aws_lb_listener.api_https[0]",
  "aws_cloudfront_function.docs_index_rewrite",
  "aws_cloudfront_origin_access_control.frontend_oac",
  "aws_s3_bucket.frontend",
  "aws_route53_record.frontend_alias[0]",
])("rejects a change to %s outside the scope", (address) =>
  rejected((plan) => {
    forceUpdate(plan, address);
  }),
);

test("requires the site buckets and docs function as unchanged dependencies", () =>
  rejected((plan) => {
    dropResource(plan, "aws_s3_bucket.docs");
  }));

test.each([
  ["a changed origin", (v: Values) => (v.origin = [{ origin_id: "other" }])],
  ["a changed alias", (v: Values) => (v.aliases = ["other.example.test"])],
  ["a disabled distribution", (v: Values) => (v.enabled = false)],
  [
    "an index fallback error page",
    (v: Values) =>
      v.custom_error_response.push({
        error_caching_min_ttl: 0,
        error_code: 404,
        response_code: 200,
        response_page_path: "/index.html",
      }),
  ],
  [
    "a changed default TTL",
    (v: Values) => (v.default_cache_behavior[0].default_ttl = 1),
  ],
  [
    "a second new behavior",
    (v: Values) =>
      v.ordered_cache_behavior.push({
        ...v.ordered_cache_behavior[1],
        path_pattern: "/other/*",
      }),
  ],
  [
    "an edited existing behavior",
    (v: Values) => (v.ordered_cache_behavior[0].max_ttl = 1),
  ],
  [
    "a write method on the new behavior",
    (v: Values) =>
      (v.ordered_cache_behavior[1].allowed_methods = ["GET", "HEAD", "POST"]),
  ],
  [
    "another origin on the new behavior",
    (v: Values) => (v.ordered_cache_behavior[1].target_origin_id = "other"),
  ],
  [
    "a Lambda association",
    (v: Values) =>
      (v.ordered_cache_behavior[1].lambda_function_association = [{}]),
  ],
])("rejects a frontend update with %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(change(plan, frontend).after);
  }),
);

test("rejects a known foreign function on the frontend default behavior", () =>
  rejected((plan) => {
    const value = change(plan, frontend);
    value.after_unknown.default_cache_behavior = [{}];
    value.after.default_cache_behavior[0].function_association = [
      {
        event_type: "viewer-request",
        function_arn: `arn:aws:cloudfront::${siteAccountId}:function/other`,
      },
    ];
  }));

test.each([
  [
    "a different function",
    (v: Values) =>
      (v.ordered_cache_behavior[1].function_association = [
        { event_type: "viewer-request", function_arn: "other" },
      ]),
  ],
  [
    "a viewer-response function",
    (v: Values) =>
      ((
        v.ordered_cache_behavior[1].function_association as {
          event_type: string;
        }[]
      )[0].event_type = "viewer-response"),
  ],
  ["a changed root object", (v: Values) => (v.default_root_object = "x.html")],
])("rejects a docs update with %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(change(plan, docs).after);
  }),
);

test.each([
  [
    "an existing behavior",
    (u: Record<string, unknown>) =>
      (u.ordered_cache_behavior = [{ grpc_config: true }, {}]),
  ],
  [
    "an origin",
    (u: Record<string, unknown>) => (u.origin = [{ domain_name: true }]),
  ],
  [
    "the default behavior forwarding",
    (u: Record<string, unknown>) =>
      (u.default_cache_behavior = [{ forwarded_values: [{ headers: true }] }]),
  ],
  [
    "a new behavior's target origin",
    (u: Record<string, unknown>) =>
      ((u.ordered_cache_behavior as Record<string, unknown>[])[1] = {
        target_origin_id: true,
      }),
  ],
])("rejects a frontend unknown on %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(change(plan, frontend).after_unknown);
  }),
);

test("rejects an unknown docs function on the new behavior", () =>
  rejected((plan) => {
    (
      change(plan, docs).after_unknown.ordered_cache_behavior as Record<
        string,
        unknown
      >[]
    )[1].function_association = [{ function_arn: true }];
  }));

test.each([
  [routeRewrite, "code"],
  [headers, "name"],
])("rejects an unknown %s %s on create", (address, key) =>
  rejected((plan) => {
    change(plan, address).after_unknown[key] = true;
  }),
);

test("rejects an unknown value outside the new references", () =>
  rejected((plan) => {
    change(plan, docs).after_unknown.price_class = true;
  }));

test.each([
  ["a renamed function", (a: Record<string, unknown>) => (a.name = "other")],
  ["edited code", (a: Record<string, unknown>) => (a.code += "\n// edit")],
  [
    "an unpublished function",
    (a: Record<string, unknown>) => (a.publish = false),
  ],
])("rejects a route function with %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(change(plan, routeRewrite).after);
  }),
);

test("rejects a headers policy with another header", () =>
  rejected((plan) => {
    (
      change(plan, headers).after as unknown as {
        custom_headers_config: { items: { header: string }[] }[];
      }
    ).custom_headers_config[0].items[0].header = "Access-Control-Allow-Origin";
  }));

test("refuses a missing account binding", () => {
  expect(validate(sitePlan(), "").status).toBe(1);
});
