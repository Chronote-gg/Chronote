import test from "node:test";
import { parse } from "yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) =>
  readFileSync(new URL("../" + name, import.meta.url), "utf8");
const release = "0873869f6b8fd80150d24689849ec0aebd94e9dd";

function hasVisibleQualityExceptionHeading(template) {
  let inComment = false;
  for (const [token] of template.matchAll(
    /<!--|--!?>|^## Quality exception[ \t]*\r?$/gm,
  )) {
    if (token === "<!--") inComment = true;
    else if (token === "-->" || token === "--!>") inComment = false;
    else if (!inComment) return true;
  }
  return false;
}

test("the quality exception heading must be outside HTML comments", () => {
  for (const [template, expected] of [
    ["## Quality exception\n", true],
    ["## Quality exception \t\r\n", true],
    ["<!--\n## Quality exception\n-->", false],
    ["<!--\n## Quality exception\n", false],
    ["<!-- instructions -->\n## Quality exception\n", true],
    ["<!-- instructions --!>\n## Quality exception\n", true],
    ["<!--\n## Quality exception\n-->\n## Quality exception\n", true],
    ["## Summary\n", false],
    ["### Quality exception\n", false],
  ]) {
    assert.equal(
      hasVisibleQualityExceptionHeading(template),
      expected,
      template,
    );
  }
});

test("the shared action runs for every PR and exception change with read-only access", () => {
  const workflow = parse(read(".github/workflows/code-quality.yml"));
  assert.deepEqual(workflow.on, {
    pull_request: {
      types: [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "edited",
        "labeled",
        "unlabeled",
      ],
    },
  });
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(workflow.concurrency.group, /github.event.pull_request.number/);
  assert.deepEqual(Object.keys(workflow.jobs), ["quality"]);
  const job = workflow.jobs.quality;
  assert.equal(job.name, "Code quality ratchet");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 20);
  assert.equal(job.secrets, undefined);
  assert.equal(job.steps.length, 3);
  const [checkout, action, diagnostic] = job.steps;
  assert.equal(
    checkout.uses,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  assert.deepEqual(checkout.with, {
    ref: "${{ github.event.pull_request.head.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  assert.equal(action.uses, "BASIC-BIT/quality-ratchet@" + release);
  assert.deepEqual(action.with, {
    "github-token": "${{ github.token }}",
    "repository-path": "${{ github.workspace }}",
  });
  assert.equal(action.id, "quality");
  assert.equal(action.if, undefined);
  assert.equal(action["continue-on-error"], undefined);
  assert.equal(diagnostic.name, "Print quality summary");
  assert.equal(
    diagnostic.if,
    "${{ failure() && !cancelled() && steps.quality.outputs.report-directory != '' }}",
  );
  assert.equal(diagnostic.shell, "bash");
  assert.deepEqual(diagnostic.env, {
    QUALITY_REPORT_DIRECTORY: "${{ steps.quality.outputs.report-directory }}",
  });
  assert.match(diagnostic.run, /randomUUID/);
  assert.match(diagnostic.run, /::stop-commands::/);
  assert.match(
    diagnostic.run,
    /cat -- "\$QUALITY_REPORT_DIRECTORY\/summary\.md"/,
  );
  assert.doesNotMatch(
    diagnostic.run,
    /quality-results\.json|quality-evidence\.json/,
  );
  assert.equal(diagnostic["continue-on-error"], undefined);
});

test("local and broad checks use the shared launcher and consumer contracts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.scripts["check:quality"],
    "node scripts/run-shared-quality.mjs",
  );
  assert.equal(
    pkg.scripts["test:quality"],
    "node --test scripts/quality-workflow.test.mjs scripts/shared-quality.test.mjs scripts/lint-staged-win.test.cjs",
  );
  for (const name of ["check:parallel", "check:ci"]) {
    assert.match(pkg.scripts[name], /check:quality/);
    assert.match(pkg.scripts[name], /test:quality/);
  }
  assert.match(read("scripts/run-shared-quality.mjs"), new RegExp(release));
  assert.equal(pkg.devDependencies.jscpd, undefined);
  assert.equal(pkg.devDependencies["@jscpd/tokenizer"], undefined);
  assert.equal(pkg.devDependencies["eslint-plugin-sonarjs"], undefined);
});

test("diagnostics and deployment checks remain outside strict PR policy", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["code:stats"], /lizard -i -1/);
  for (const name of ["ci-core.yml", "deploy-staging.yml"]) {
    const workflow = read(".github/workflows/" + name);
    assert.match(workflow, /lizard -i -1/);
    assert.doesNotMatch(workflow, /lizard -W|run:.*check:quality/);
  }
  assert.match(
    read(".github/workflows/ci-core.yml"),
    /unittest discover -s analysis\/hallucination-audit/,
  );
  assert.match(
    read(".github/workflows/deploy.yml"),
    /uses: \.\/.github\/workflows\/ci-core.yml/,
  );
  const core = parse(read(".github/workflows/ci-core.yml"));
  const steps = core.jobs["code-quality"].steps;
  assert.equal(
    steps.filter((step) => step.run === "yarn test:quality").length,
    1,
  );
  assert.ok(
    steps.findIndex((step) => step.run === "yarn test:quality") >
      steps.findIndex(
        (step) => step.run === "bash scripts/ci-install-dependencies.sh",
      ),
  );
  assert.ok(
    hasVisibleQualityExceptionHeading(read(".github/pull_request_template.md")),
  );
});
