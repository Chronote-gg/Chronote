---
name: langfuse-metrics
description: Query aggregate Langfuse cost, volume, latency, and model telemetry efficiently with Metrics API v2. Use for dashboards, rollout checks, usage summaries, and cost or latency comparisons; use Observations API v2 instead when individual rows are actually required.
---

# Langfuse Metrics

Prefer one bounded `GET /api/public/v2/metrics` query over downloading and
aggregating observations. Metrics queries return aggregates and avoid exposing
prompt or output content.

Use [`scripts/query-metrics-v2.mjs`](scripts/query-metrics-v2.mjs):

```text
node .codex/skills/langfuse-metrics/scripts/query-metrics-v2.mjs summary --from 2026-08-26T00:00:00Z --model-prefix gpt-5.6-
node .codex/skills/langfuse-metrics/scripts/query-metrics-v2.mjs query --file query.json
```

The helper reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optional
`LANGFUSE_BASE_URL` (Chronote defaults to the US cloud host). `summary` makes a
single request grouped by provided model and observation name, returning count,
total cost, average latency, and p95 latency. Use `--dry-run` to inspect the
query without sending it.

Keep queries bounded with explicit UTC `fromTimestamp` and `toTimestamp`.
Start with the dimensions and metrics needed to answer the question; do not add
time buckets or high row limits speculatively. Metrics API v2 supports at most
1,000 rows and does not permit grouping by high-cardinality identifiers such as
trace, session, or user IDs.

Before interpreting an empty result as no traffic, check ingestion freshness.
Data from Langfuse Python SDK versions before 4.7 or JS/TS versions before 5.4
can appear in v2 endpoints up to 15 minutes late.

If row-level investigation is necessary, use `GET /api/public/v2/observations`
with bounded `fromStartTime` and `toStartTime`, selective `fields`, and cursor
pagination. Do not use deprecated `/api/public/observations` or page-based
pagination. Omit the `io` field group unless the task genuinely requires user
content and that access is authorized.

On HTTP 429, honor `Retry-After`. The helper retries once only when the wait is
60 seconds or less; otherwise it stops and reports the wait. Do not work around
an organization-wide quota by rotating project keys. Langfuse applies rate
limits to organization-level resource buckets shared by its projects and keys.

Aggregate health does not prove output quality. Report routing/configuration,
traffic, latency, cost, and error evidence separately from representative
workload or human quality validation. This skill is read-only and does not
authorize prompt, model-routing, evaluator, or production configuration writes.

Current official references:

- https://langfuse.com/docs/metrics/features/metrics-api
- https://langfuse.com/guides/cookbook/example_metrics_api_v2
- https://langfuse.com/docs/api-and-data-platform/features/observations-api
