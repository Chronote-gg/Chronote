/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
import {
  evaluateMergedChecks,
  verifyMergedChecks,
} from "../../scripts/deployment/break-glass-checks.cjs";
import { runGate } from "../../scripts/deployment/break-glass-guard.cjs";
import {
  checkRun,
  dispatchEnv,
  greenChecks,
  headSha,
  mergeSha,
  mergedCommit,
} from "../deployment/fixtures/breakGlassFixture";

const gateEnv = {
  ...dispatchEnv,
  GITHUB_REPOSITORY: "Chronote-gg/Chronote",
  GITHUB_TOKEN: "token",
};
const answer = (object: unknown) =>
  jest.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ data: { repository: { object } } })),
  );

test("a merged master pull request with green required checks passes", () => {
  expect(
    evaluateMergedChecks(
      mergedCommit([
        ...greenChecks(),
        checkRun("Visual Regression", {
          conclusion: "SKIPPED",
        }),
      ]),
      mergeSha,
    ),
  ).toEqual({ pullRequest: 567, headSha, checkRuns: 6 });
});

test("a re-run supersedes its cancelled attempt", () => {
  const contexts = [
    checkRun("Code quality ratchet", {
      conclusion: "CANCELLED",
      databaseId: 1,
      workflow: "Code quality",
    }),
    ...greenChecks().map((run) => ({ ...run, databaseId: 2 })),
  ];
  expect(evaluateMergedChecks(mergedCommit(contexts), mergeSha)).toMatchObject({
    checkRuns: 5,
  });
});

test.each([
  ["a failed check", { conclusion: "FAILURE", databaseId: 9 }, /not green/],
  ["a running check", { status: "IN_PROGRESS", databaseId: 9 }, /not green/],
  [
    "a skipped required check",
    { conclusion: "SKIPPED", databaseId: 9 },
    /did not pass: Core CI \/ Unit Tests/,
  ],
])("refuses %s", (_case, change, message) => {
  const contexts = [...greenChecks(), checkRun("Core CI / Unit Tests", change)];
  expect(() => evaluateMergedChecks(mergedCommit(contexts), mergeSha)).toThrow(
    message,
  );
});

test("refuses a missing required check", () => {
  const contexts = greenChecks().filter(
    (run) => run.name !== "Core CI / Docker Build",
  );
  expect(() => evaluateMergedChecks(mergedCommit(contexts), mergeSha)).toThrow(
    /did not pass: Core CI \/ Docker Build/,
  );
});

test.each([
  ["another app", { app: "lookalike-app" }],
  ["another workflow", { workflow: "Untrusted" }],
])("a same-named check from %s does not satisfy the gate", (_case, origin) => {
  const contexts = [
    ...greenChecks().filter((run) => run.name !== "Code quality ratchet"),
    checkRun("Code quality ratchet", origin),
  ];
  expect(() => evaluateMergedChecks(mergedCommit(contexts), mergeSha)).toThrow(
    /did not pass: Code quality ratchet/,
  );
});

test("refuses a failing commit status", () => {
  const contexts = [
    ...greenChecks(),
    { __typename: "StatusContext", context: "legacy", state: "FAILURE" },
  ];
  expect(() => evaluateMergedChecks(mergedCommit(contexts), mergeSha)).toThrow(
    /commit status/,
  );
});

test.each([
  ["an unmerged pull request", { merged: false }],
  ["another base branch", { baseRefName: "release" }],
  ["another merge commit", { mergeCommit: { oid: "f".repeat(40) } }],
])("refuses %s", (_case, pr) => {
  expect(() =>
    evaluateMergedChecks(mergedCommit(greenChecks(), pr), mergeSha),
  ).toThrow(/merge commit of one master pull request/);
});

test("refuses a commit with no pull request", () => {
  expect(() => evaluateMergedChecks(undefined, mergeSha)).toThrow(
    /merge commit/,
  );
});

test("refuses an incomplete check list", () => {
  const commit = mergedCommit();
  const contexts =
    commit.associatedPullRequests.nodes[0].commits.nodes[0].commit
      .statusCheckRollup.contexts;
  contexts.totalCount = 101;
  expect(() => evaluateMergedChecks(commit, mergeSha)).toThrow(/incomplete/);
});

test("refuses a head commit other than the pull request head", () => {
  expect(() =>
    evaluateMergedChecks(
      mergedCommit(greenChecks(), { headRefOid: "f".repeat(40) }),
      mergeSha,
    ),
  ).toThrow(/head commit/);
});

test("asks GitHub once for the exact commit with the job token", async () => {
  const request = answer(mergedCommit());
  await expect(verifyMergedChecks(gateEnv, request)).resolves.toMatchObject({
    pullRequest: 567,
  });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  expect(url).toBe("https://api.github.com/graphql");
  expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
  expect(JSON.parse(String(init?.body)).variables).toEqual({
    owner: "Chronote-gg",
    name: "Chronote",
    sha: mergeSha,
  });
});

test("refuses a GraphQL error and a missing token", async () => {
  const errors = jest.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ errors: [{ message: "no" }] })),
  );
  await expect(verifyMergedChecks(gateEnv, errors)).rejects.toThrow(
    /did not answer/,
  );
  await expect(
    verifyMergedChecks({ ...gateEnv, GITHUB_TOKEN: "" }, errors),
  ).rejects.toThrow(/token are required/);
  expect(errors).toHaveBeenCalledTimes(1);
});

test("the gate admits a verified dispatch and reports the pull request", async () => {
  const out = { log: jest.fn(), error: jest.fn() };
  await expect(runGate(gateEnv, out, answer(mergedCommit()))).resolves.toBe(0);
  expect(JSON.parse(String(out.log.mock.calls[0][0]))).toMatchObject({
    kind: "break_glass_admitted",
    pullRequest: 567,
    actor: "BASIC-BIT",
    manifestSha256: "d".repeat(64),
  });
});
