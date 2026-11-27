/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../scripts/alarm-delivery-report";

const TITLE = "Alarm delivery check is failing";
const RUN_URL = "https://example.test/runs/1";
const FAILED = "could not read alarm history";

type Issue = { number: number; state: "OPEN" | "CLOSED"; latest: string };

/** Runs the report against a fake gh and returns the write commands it sent. */
function report(result: string, existing?: Issue, failures = FAILED) {
  const writes: string[][] = [];
  const gh = (args: string[]) => {
    if (args[1] === "list")
      return JSON.stringify(
        existing
          ? [
              { number: 2, title: `${TITLE} (old)`, state: "OPEN" },
              { number: existing.number, title: TITLE, state: existing.state },
            ]
          : [],
      );
    if (args[1] === "view") return existing?.latest ?? "";
    writes.push(args);
    return "";
  };
  run({ TITLE, RESULT: result, FAILURES: failures, RUN_URL }, gh);
  return writes;
}
const posted = (writes: string[][]) => writes.map((args) => args.join(" "));

test("searches every state by exact title", () => {
  const listed: string[][] = [];
  run({ TITLE, RESULT: "success", FAILURES: "", RUN_URL }, (args) => {
    listed.push(args);
    return "[]";
  });
  expect(listed[0]).toEqual(
    expect.arrayContaining(["--state", "all", `in:title "${TITLE}"`]),
  );
});

test("a failure with no issue creates one naming the cause", () => {
  const [create] = report("failure");
  expect(create.slice(0, 4)).toEqual(["issue", "create", "--title", TITLE]);
  expect(create[5]).toContain(`Failure: ${FAILED}.`);
  expect(create[5]).toContain("may not be reaching anyone");
});

test("a failure reopens a closed issue instead of creating a second one", () => {
  const writes = report("failure", { number: 7, state: "CLOSED", latest: "" });
  expect(posted(writes)[0]).toBe("issue reopen 7");
  expect(writes[1].slice(0, 3)).toEqual(["issue", "comment", "7"]);
  expect(writes.some((args) => args[1] === "create")).toBe(false);
});

test("the same failure is not posted twice in a row, a new one is", () => {
  // The body an earlier run posted, with its own run link.
  const latest = report("failure")[0][5].replace(RUN_URL, "earlier");
  expect(report("failure", { number: 7, state: "OPEN", latest })).toEqual([]);
  const writes = report(
    "failure",
    { number: 7, state: "OPEN", latest },
    "could not list subscriptions of the topic",
  );
  expect(writes[0].slice(0, 3)).toEqual(["issue", "comment", "7"]);
});

test.each(["cancelled", "skipped"])(
  "a %s run never claims alarms are lost and never opens an issue",
  (result) => {
    expect(report(result)).toEqual([]);
    expect(report(result, { number: 7, state: "CLOSED", latest: "" })).toEqual(
      [],
    );
    const [comment] = report(result, { number: 7, state: "OPEN", latest: "" });
    expect(comment[4]).toContain("did not complete");
    expect(comment[4]).not.toContain("may not be reaching anyone");
    expect(
      report(result, { number: 7, state: "OPEN", latest: comment[4] }),
    ).toEqual([]);
  },
);

test("a passing run closes an open issue and leaves a closed one alone", () => {
  expect(
    posted(report("success", { number: 7, state: "OPEN", latest: "" }))[0],
  ).toContain(
    "issue close 7 --comment [AGENT] The alarm delivery check passed again",
  );
  expect(report("success", { number: 7, state: "CLOSED", latest: "" })).toEqual(
    [],
  );
});

test("a role the run cannot assume is reported as that, not as lost alarms alone", () => {
  const workflow = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      ".github",
      "workflows",
      "alarm-delivery-check.yml",
    ),
    "utf8",
  );
  expect(workflow).toContain("could not assume the check role");
  expect(workflow).toMatch(/steps\.credentials\.outcome == 'failure'/);
  expect(workflow).toContain("node scripts/alarm-delivery-report.js");
});
