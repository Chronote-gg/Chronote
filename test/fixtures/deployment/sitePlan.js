// Synthetic `terraform show -json` shape for the site-delivery scope: the
// pre-#347 live distributions updated to master's routing.
import { readFileSync } from "node:fs";

export const siteAccountId = "123456789012";
const docsFunction = `arn:aws:cloudfront::${siteAccountId}:function/meeting-notes-prod-docs-index-rewrite`;
const managed = (address, actions, change = {}) => ({
  address,
  mode: "managed",
  change: { actions, ...change },
});
const forwarded = [{ query_string: false, cookies: [{ forward: "none" }] }];
const behavior = (origin, extra = {}) => ({
  allowed_methods: ["HEAD", "GET"],
  cached_methods: ["HEAD", "GET"],
  compress: true,
  default_ttl: 600,
  forwarded_values: forwarded,
  function_association: [],
  lambda_function_association: [],
  max_ttl: 3600,
  min_ttl: 0,
  response_headers_policy_id: "",
  target_origin_id: origin,
  trusted_key_groups: [],
  trusted_signers: [],
  viewer_protocol_policy: "redirect-to-https",
  ...extra,
});
const assets = (origin) =>
  behavior(origin, {
    path_pattern: "/assets/*",
    default_ttl: 86400,
    max_ttl: 31536000,
    min_ttl: 3600,
  });
const distribution = (name, origin, extra) => ({
  aliases: [`${name}.example.test`],
  default_root_object: "index.html",
  enabled: true,
  etag: "E1",
  origin: [{ domain_name: `${name}.s3`, origin_id: origin }],
  price_class: "PriceClass_100",
  status: "Deployed",
  tags_all: { Project: "meeting-notes" },
  viewer_certificate: [{ minimum_protocol_version: "TLSv1.2_2021" }],
  ...extra,
});
const unknownFields = (...keys) =>
  Object.fromEntries(keys.map((key) => [key, true]));
const newFunction = { function_association: [{ function_arn: true }] };
// AWS 6.70 computes these on a newly added cache behavior.
const newBehavior = {
  forwarded_values: [{ headers: true, query_string_cache_keys: true }],
  grpc_config: true,
  response_headers_policy_id: true,
};

function frontendChange() {
  const before = distribution("frontend", "frontend-s3", {
    custom_error_response: [403, 404].map((code) => ({
      error_caching_min_ttl: 0,
      error_code: code,
      response_code: 200,
      response_page_path: "/index.html",
    })),
    default_cache_behavior: [behavior("frontend-s3")],
    ordered_cache_behavior: [assets("frontend-s3")],
  });
  const routed = { event_type: "viewer-request", function_arn: null };
  const after = {
    ...structuredClone(before),
    custom_error_response: [
      {
        error_caching_min_ttl: 0,
        error_code: 403,
        response_code: 404,
        response_page_path: "/404.html",
      },
    ],
    default_cache_behavior: [
      { ...behavior("frontend-s3"), function_association: [routed] },
    ],
    ordered_cache_behavior: [
      assets("frontend-s3"),
      behavior("frontend-s3", {
        path_pattern: "/share/*",
        function_association: [routed],
        response_headers_policy_id: null,
      }),
    ],
  };
  const after_unknown = {
    default_cache_behavior: [newFunction],
    ordered_cache_behavior: [{}, { ...newFunction, ...newBehavior }],
    tags_all: {},
  };
  return { before, after, after_unknown };
}

function docsChange() {
  const associated = {
    function_association: [
      { event_type: "viewer-request", function_arn: docsFunction },
    ],
  };
  const before = distribution("docs", "docs-s3", {
    custom_error_response: [],
    default_cache_behavior: [behavior("docs-s3", associated)],
    ordered_cache_behavior: [assets("docs-s3")],
  });
  const after = {
    ...structuredClone(before),
    ordered_cache_behavior: [
      assets("docs-s3"),
      behavior("docs-s3", {
        ...associated,
        path_pattern: "/search*",
        response_headers_policy_id: null,
      }),
    ],
  };
  const after_unknown = {
    ordered_cache_behavior: [{}, newBehavior],
  };
  return { before, after, after_unknown };
}

export function sitePlan() {
  return {
    resource_changes: [
      ...[
        "aws_s3_bucket.frontend",
        "aws_s3_bucket.docs",
        "aws_cloudfront_function.docs_index_rewrite",
        "aws_cloudfront_origin_access_control.frontend_oac",
      ].map((address) => managed(address, ["no-op"])),
      managed("aws_cloudfront_function.frontend_route_rewrite", ["create"], {
        after: {
          name: "meeting-notes-prod-frontend-route-rewrite",
          runtime: "cloudfront-js-2.0",
          publish: true,
          code: readFileSync(
            "_infra/functions/frontend-route-rewrite.js",
            "utf8",
          ),
        },
        after_unknown: unknownFields(
          "arn",
          "etag",
          "id",
          "live_stage_etag",
          "status",
        ),
      }),
      managed(
        "aws_cloudfront_response_headers_policy.crawler_noindex",
        ["create"],
        {
          after: {
            name: "meeting-notes-prod-crawler-noindex",
            cors_config: [],
            custom_headers_config: [
              {
                items: [
                  {
                    header: "X-Robots-Tag",
                    value: "noindex, nofollow",
                    override: true,
                  },
                ],
              },
            ],
          },
          after_unknown: unknownFields("arn", "etag", "id"),
        },
      ),
      managed(
        "aws_cloudfront_distribution.frontend",
        ["update"],
        frontendChange(),
      ),
      managed("aws_cloudfront_distribution.docs", ["update"], docsChange()),
    ],
  };
}
