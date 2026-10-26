/** @jest-environment node */
import { expect, test, jest } from "@jest/globals";
import { createWriterInventory } from "../../scripts/deployment/carryforward-writers.cjs";
function fixture() {
  const env = {
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
    GITHUB_RUN_ID: "901",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_TOKEN: "PRIVATE_TOKEN",
  };
  const own = {
    id: 901,
    status: "in_progress",
    head_sha: env.GITHUB_SHA,
    run_attempt: 1,
  };
  const state = {
    extra: undefined,
    denied: false,
    page: false,
    wrongHead: false,
  };
  const fetchImpl = jest.fn(async (url, options) => {
    if (state.denied) return { ok: false };
    const parsed = new URL(url);
    const current =
      parsed.pathname.includes("sandbox-identity.yml") &&
      parsed.searchParams.get("status") === "in_progress";
    const extra =
      state.extra &&
      parsed.pathname.includes(state.extra.path) &&
      parsed.searchParams.get("status") === state.extra.status;
    let rows = current
      ? [{ ...own, head_sha: state.wrongHead ? "b".repeat(40) : own.head_sha }]
      : [];
    if (extra)
      rows.push({
        id: 902,
        status: state.extra.status,
        head_sha: env.GITHUB_SHA,
        run_attempt: 1,
      });
    if (state.page && current)
      rows =
        parsed.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, i) => ({ ...own, id: i + 901 }))
          : [{ ...own, id: 2000 }];
    const data = {
      total_count: state.page && current ? 101 : rows.length,
      workflow_runs: rows,
    };
    const etag = JSON.stringify(data);
    if (options.headers["If-None-Match"] === etag)
      return { status: 304, ok: false };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ etag }),
      json: async () => data,
    };
  });
  return {
    env,
    state,
    fetchImpl,
    inventory: createWriterInventory({ env, fetchImpl }),
  };
}
test("exclusive live inventory reads all relevant status/workflow combinations without leaking credentials", async () => {
  const f = fixture();
  expect(await f.inventory.assertExclusive()).toMatchObject({ competing: 0 });
  expect(f.fetchImpl).toHaveBeenCalledTimes(15);
  expect(JSON.stringify(await f.inventory.assertExclusive())).not.toContain(
    "PRIVATE_TOKEN",
  );
});

test("each repeated read revalidates its exact page and still rejects a newly competing writer", async () => {
  const f = fixture();
  await f.inventory.assertExclusive();
  await f.inventory.assertExclusive();
  expect(
    f.fetchImpl.mock.calls
      .slice(15)
      .every(([, options]) => options.headers["If-None-Match"]),
  ).toBe(true);
  f.state.extra = { path: "terraform-apply.yml", status: "waiting" };
  await expect(f.inventory.assertExclusive()).rejects.toThrow("Competing");
  f.state.denied = true;
  await expect(f.inventory.assertExclusive()).rejects.toThrow(
    "could not be read",
  );
});

test("an unbound not-modified response cannot establish an inventory", async () => {
  const f = fixture();
  f.fetchImpl.mockResolvedValue({ status: 304, ok: false });
  await expect(f.inventory.assertExclusive()).rejects.toThrow();
});
test.each(["queued", "in_progress", "waiting", "requested", "pending"])(
  "a %s writer refuses before deployment",
  async (status) => {
    const f = fixture();
    f.state.extra = { path: "deploy-staging.yml", status };
    await expect(f.inventory.assertExclusive()).rejects.toThrow();
  },
);
test("pagination is complete before accepting or refusing a competing-operation snapshot", async () => {
  const f = fixture();
  f.state.page = true;
  await expect(f.inventory.assertExclusive()).rejects.toThrow();
  expect(f.fetchImpl.mock.calls.some(([url]) => url.includes("page=2"))).toBe(
    true,
  );
});
test.each(["denied", "wrongHead"])(
  "unproved %s inventory refuses",
  async (key) => {
    const f = fixture();
    f.state[key] = true;
    await expect(f.inventory.assertExclusive()).rejects.toThrow();
  },
);
