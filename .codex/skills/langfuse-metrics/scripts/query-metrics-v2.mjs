#!/usr/bin/env node

import fs from "node:fs";

const DEFAULT_BASE_URL = "https://us.cloud.langfuse.com";
const MAX_RETRY_AFTER_SECONDS = 60;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const parseArgs = (argv) => {
  const options = { command: argv[0] || "summary" };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (["dry-run", "compact"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
};

const parseTimestamp = (value, label) => {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime()))
    fail(`Invalid ${label}: ${value}`);
  return parsed.toISOString();
};

const buildSummaryQuery = (options) => {
  const toTimestamp = parseTimestamp(
    options.to || new Date().toISOString(),
    "--to",
  );
  const defaultFrom = new Date(
    new Date(toTimestamp).getTime() - 24 * 60 * 60 * 1000,
  );
  const fromTimestamp = parseTimestamp(
    options.from || defaultFrom.toISOString(),
    "--from",
  );
  if (new Date(fromTimestamp) >= new Date(toTimestamp)) {
    fail("--from must be earlier than --to");
  }

  const query = {
    view: "observations",
    metrics: [
      { measure: "count", aggregation: "count" },
      { measure: "totalCost", aggregation: "sum" },
      { measure: "latency", aggregation: "avg" },
      { measure: "latency", aggregation: "p95" },
    ],
    dimensions: [{ field: "providedModelName" }, { field: "name" }],
    filters: [],
    fromTimestamp,
    toTimestamp,
    orderBy: [{ field: "count_count", direction: "desc" }],
    config: { row_limit: 1000 },
  };

  if (options.granularity) {
    if (!["hour", "day", "week", "month"].includes(options.granularity)) {
      fail("--granularity must be hour, day, week, or month");
    }
    query.timeDimension = { granularity: options.granularity };
  }
  return query;
};

const loadQuery = (options) => {
  if (["summary", "cost-report"].includes(options.command)) {
    return buildSummaryQuery(options);
  }
  if (options.command !== "query") {
    fail("Command must be summary, cost-report, or query");
  }
  if (!options.file) fail("query requires --file <path>");
  const parsed = JSON.parse(fs.readFileSync(options.file, "utf8"));
  if (!parsed.fromTimestamp || !parsed.toTimestamp) {
    fail("Custom queries require fromTimestamp and toTimestamp");
  }
  return parsed;
};

const normalizeNumbers = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (
        /^(count|sum|avg|p\d+|min|max)_/.test(key) &&
        value !== null &&
        value !== ""
      ) {
        const number = Number(value);
        if (Number.isFinite(number)) return [key, number];
      }
      return [key, value];
    }),
  );

const nonnegativeNumberOption = (value, label) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${label} must be a nonnegative number`);
  }
  return number;
};

const sumBy = (rows, key) => {
  const totals = new Map();
  for (const row of rows) {
    const label = String(row[key] || "unknown");
    totals.set(
      label,
      (totals.get(label) || 0) + Number(row.sum_totalCost || 0),
    );
  }
  return [...totals.entries()]
    .map(([label, totalCost]) => ({ [key]: label, totalCost }))
    .sort((left, right) => right.totalCost - left.totalCost);
};

const buildCostReport = (rows, options) => {
  const modelRows = rows.filter((row) => Boolean(row.providedModelName));
  const totalCost = modelRows.reduce(
    (total, row) => total + Number(row.sum_totalCost || 0),
    0,
  );
  const modelObservationCount = modelRows.reduce(
    (total, row) => total + Number(row.count_count || 0),
    0,
  );
  const pricedGroupRows = modelRows.filter(
    (row) => Number(row.sum_totalCost || 0) > 0,
  );
  const observationsInPricedGroups = pricedGroupRows.reduce(
    (total, row) => total + Number(row.count_count || 0),
    0,
  );
  const unpricedGroups = modelRows
    .filter(
      (row) =>
        Number(row.count_count || 0) > 0 &&
        Number(row.sum_totalCost || 0) === 0,
    )
    .map((row) => ({
      providedModelName: row.providedModelName,
      name: row.name,
      observationCount: Number(row.count_count || 0),
    }))
    .sort((left, right) => right.observationCount - left.observationCount);
  const observationsInUnpricedGroups = unpricedGroups.reduce(
    (total, row) => total + row.observationCount,
    0,
  );
  const completedMeetings = nonnegativeNumberOption(
    options["completed-meetings"],
    "--completed-meetings",
  );
  const transcribedMinutes = nonnegativeNumberOption(
    options["transcribed-minutes"],
    "--transcribed-minutes",
  );

  return {
    window: {
      fromTimestamp: options.from,
      toTimestamp: options.to,
    },
    totalAttributedCost: totalCost,
    modelObservationCount,
    observationsInPricedGroups,
    observationsInUnpricedGroups,
    pricedGroupObservationRatio:
      modelObservationCount === 0
        ? null
        : observationsInPricedGroups / modelObservationCount,
    unitCosts: {
      ...(completedMeetings !== undefined
        ? {
            costPerCompletedMeeting:
              completedMeetings === 0 ? null : totalCost / completedMeetings,
          }
        : {}),
      ...(transcribedMinutes !== undefined
        ? {
            costPerTranscribedMinute:
              transcribedMinutes === 0 ? null : totalCost / transcribedMinutes,
          }
        : {}),
    },
    costByModel: sumBy(modelRows, "providedModelName"),
    costByFeature: sumBy(modelRows, "name"),
    unpricedGroups,
    coverageNote:
      "Coverage is group-based: a priced aggregate can still contain individual unpriced observations.",
  };
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestMetrics = async ({ baseUrl, auth, query }, attempt = 0) => {
  const url = new URL("/api/public/v2/metrics", baseUrl);
  url.searchParams.set("query", JSON.stringify(query));
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (
      attempt === 0 &&
      Number.isFinite(retryAfter) &&
      retryAfter <= MAX_RETRY_AFTER_SECONDS
    ) {
      console.error(`Rate limited; retrying once after ${retryAfter}s.`);
      await sleep(retryAfter * 1000);
      return requestMetrics({ baseUrl, auth, query }, 1);
    }
    fail(
      `Langfuse rate limit reached.${Number.isFinite(retryAfter) ? ` Retry after ${retryAfter}s.` : ""}`,
    );
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    fail(`Langfuse HTTP ${response.status}: ${body}`);
  }
  return response.json();
};

const options = parseArgs(process.argv.slice(2));
const query = loadQuery(options);

options.from = query.fromTimestamp;
options.to = query.toTimestamp;

if (options["dry-run"]) {
  console.log(JSON.stringify(query, null, options.compact ? 0 : 2));
  process.exit(0);
}

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
if (!publicKey || !secretKey) {
  fail("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required");
}

const baseUrl = (process.env.LANGFUSE_BASE_URL || DEFAULT_BASE_URL).replace(
  /\/$/,
  "",
);
const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
const payload = await requestMetrics({ baseUrl, auth, query });
let data = Array.isArray(payload.data)
  ? payload.data.map(normalizeNumbers)
  : [];

if (options["model-prefix"]) {
  data = data.filter((row) =>
    String(row.providedModelName || "").startsWith(options["model-prefix"]),
  );
}

const output =
  options.command === "cost-report"
    ? { query, report: buildCostReport(data, options) }
    : { query, rowCount: data.length, data };

console.log(JSON.stringify(output, null, options.compact ? 0 : 2));
