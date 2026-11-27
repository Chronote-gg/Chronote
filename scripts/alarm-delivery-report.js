// Tracks the daily alarm delivery check in one GitHub issue. Run by the report
// job of .github/workflows/alarm-delivery-check.yml with RESULT (the check
// job's result), FAILURES, TITLE and RUN_URL set, and gh authenticated.
const { execFileSync } = require("node:child_process");

const GUIDE =
  "What each failure means and what to do: docs/deployment.md#alarm-delivery.";

/**
 * Text that identifies a report, so the same failure is not posted twice in a
 * row. A failure reports its cause; a run that did not finish says only that.
 */
function reportKey(result, failures) {
  if (result !== "failure")
    return "The daily alarm delivery check did not complete, so it could not tell whether alarm notifications are reaching anyone.";
  const cause = failures || "the check job failed without recording a cause";
  return `The daily alarm delivery check failed, so production alarm notifications may not be reaching anyone. Failure: ${cause}.`;
}

/**
 * The issue operations for one run. Only a failed check opens, reopens or
 * creates the issue; a cancelled or timed-out run comments at most once, on an
 * issue that is already open, and never claims that alarms are being lost.
 */
function planReport({ result, failures, issue, lastComment, runUrl }) {
  const open = issue?.state === "OPEN";
  if (result === "success")
    return open
      ? [
          {
            kind: "close",
            number: issue.number,
            body: `[AGENT] The alarm delivery check passed again: ${runUrl}`,
          },
        ]
      : [];
  const key = reportKey(result, failures);
  const body = `[AGENT] ${key} Run: ${runUrl}. ${GUIDE}`;
  if (!issue) return result === "failure" ? [{ kind: "create", body }] : [];
  if (!open)
    return result === "failure"
      ? [
          { kind: "reopen", number: issue.number },
          { kind: "comment", number: issue.number, body },
        ]
      : [];
  if (lastComment?.includes(key)) return [];
  return [{ kind: "comment", number: issue.number, body }];
}

/** The newest issue with exactly this title, in any state, and its latest text. */
function findIssue(gh, title) {
  const found = JSON.parse(
    gh([
      "issue",
      "list",
      "--state",
      "all",
      "--search",
      `in:title "${title}"`,
      "--json",
      "number,title,state",
    ]),
  ).find((candidate) => candidate.title === title);
  if (!found) return {};
  const lastComment = gh([
    "issue",
    "view",
    String(found.number),
    "--json",
    "body,comments",
    "--jq",
    "(.comments | last | .body) // .body",
  ]);
  return { issue: { number: found.number, state: found.state }, lastComment };
}

const COMMANDS = {
  close: (step) => [
    "issue",
    "close",
    String(step.number),
    "--comment",
    step.body,
  ],
  reopen: (step) => ["issue", "reopen", String(step.number)],
  comment: (step) => [
    "issue",
    "comment",
    String(step.number),
    "--body",
    step.body,
  ],
  create: (step, title) => [
    "issue",
    "create",
    "--title",
    title,
    "--body",
    step.body,
  ],
};

function run(env, gh) {
  const { issue, lastComment } = findIssue(gh, env.TITLE);
  const steps = planReport({
    result: env.RESULT,
    failures: env.FAILURES,
    issue,
    lastComment,
    runUrl: env.RUN_URL,
  });
  for (const step of steps) gh(COMMANDS[step.kind](step, env.TITLE));
}

module.exports = { planReport, run };

if (require.main === module)
  run(process.env, (args) => execFileSync("gh", args, { encoding: "utf8" }));
