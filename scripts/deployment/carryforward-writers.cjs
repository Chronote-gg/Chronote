"use strict";
const assert = require("node:assert/strict");
const workflows = [
  "deploy-staging.yml",
  "sandbox-identity.yml",
  "terraform-apply.yml",
];
const statuses = ["queued", "in_progress", "waiting", "requested", "pending"];
function createWriterInventory({ env, fetchImpl = fetch }) {
  assert.equal(env.GITHUB_REPOSITORY, "Chronote-gg/Chronote");
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.ok(env.GITHUB_TOKEN);
  const pages = new Map();
  async function readPage(url) {
    const previous = pages.get(url);
    const response = await fetchImpl(url, {
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(previous ? { "If-None-Match": previous.etag } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 304) {
      assert.ok(previous, "Unbound writer inventory revalidation");
      return previous.data;
    }
    assert.ok(response.ok, "Writer inventory could not be read");
    const etag = response.headers.get("etag");
    assert.ok(etag, "Writer inventory must support conditional revalidation");
    const data = await response.json();
    pages.set(url, { etag, data });
    return data;
  }
  async function list(workflow, status) {
    const rows = [],
      seen = new Set();
    let total;
    for (let page = 1; page <= 11; page++) {
      const url = `https://api.github.com/repos/Chronote-gg/Chronote/actions/workflows/${workflow}/runs?status=${status}&per_page=100&page=${page}`;
      const data = await readPage(url);
      assert.ok(
        Number.isInteger(data.total_count) &&
          data.total_count <= 1000 &&
          data.total_count >= 0,
      );
      total ??= data.total_count;
      assert.equal(
        data.total_count,
        total,
        "Writer inventory changed during pagination",
      );
      assert.ok(
        Array.isArray(data.workflow_runs) && data.workflow_runs.length <= 100,
      );
      for (const row of data.workflow_runs) {
        assert.ok(Number.isSafeInteger(row.id) && !seen.has(row.id));
        assert.equal(row.status, status);
        seen.add(row.id);
        rows.push({ ...row, workflow });
      }
      if (data.workflow_runs.length < 100) break;
    }
    assert.equal(rows.length, total, "Incomplete writer inventory");
    return rows;
  }
  async function assertExclusive() {
    const pages = await Promise.all(
      workflows.flatMap((workflow) =>
        statuses.map((status) => list(workflow, status)),
      ),
    );
    const rows = pages.flat();
    const own = rows.filter((row) => String(row.id) === env.GITHUB_RUN_ID);
    assert.equal(
      own.length,
      1,
      "Current workflow identity not proved by inventory",
    );
    assert.equal(own[0].workflow, "sandbox-identity.yml");
    assert.equal(own[0].head_sha, env.GITHUB_SHA);
    assert.equal(own[0].run_attempt, 1);
    const competing = rows.filter(
      (row) => String(row.id) !== env.GITHUB_RUN_ID,
    );
    assert.equal(
      competing.length,
      0,
      "Competing or unclassified deployment operation remains",
    );
    return {
      checkedAt: new Date().toISOString(),
      competing: 0,
      workflows: [...workflows],
      statuses: [...statuses],
    };
  }
  async function originalExecution(token) {
    assert.match(token, /^\d+-[1-9]\d*$/);
    const [id, attempt] = token.split("-");
    return readPage(
      `https://api.github.com/repos/Chronote-gg/Chronote/actions/runs/${id}/attempts/${attempt}`,
    );
  }
  return { assertExclusive, originalExecution };
}
module.exports = { createWriterInventory };
