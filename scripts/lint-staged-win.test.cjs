const assert = require("node:assert/strict");
const { test } = require("node:test");
const originalExit = process.exit;
let runStagedChecks;
try {
  process.exit = () => {
    throw new Error("Importing the hook must not terminate the test process");
  };
  ({ runStagedChecks } = require("./lint-staged-win.js"));
} finally {
  process.exit = originalExit;
}

test("checks every staged path without a shell and only restages its changes", () => {
  const paths = Array.from(
    { length: 250 },
    (_, index) => `src/a directory/${"long-name-".repeat(6)}${index}.ts`,
  );
  const calls = [];
  runStagedChecks((command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("--cached")) return paths.join("\0") + "\0";
    if (args[0] === "diff") return `${paths[0]}\0unrelated dirty.ts\0`;
    return "";
  });
  for (const tool of ["eslint", "prettier"]) {
    const runs = calls.filter((call) => call.args[0].includes(tool));
    assert.ok(runs.length > 1);
    assert.deepEqual(
      runs.flatMap((call) => call.args.slice(3)),
      paths,
    );
    for (const call of runs) {
      assert.equal(call.command, process.execPath);
      assert.equal(call.options.shell, undefined);
      assert.ok(call.args.join(" ").length < 7000);
      assert.equal(call.args[2], "--");
    }
  }
  assert.deepEqual(calls.at(-1).args, ["add", "--", paths[0]]);
});

test("a failing check prevents later tools and restaging", () => {
  const calls = [];
  const failure = new Error("lint failed");
  assert.throws(
    () =>
      runStagedChecks((command, args) => {
        calls.push(args);
        if (args.includes("--cached")) return "src/example.ts\0";
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1][0].includes("eslint"));
});

test("an empty staged set invokes no formatter or staging command", () => {
  const calls = [];
  runStagedChecks((command, args) => {
    calls.push(args);
    return "";
  });
  assert.equal(calls.length, 1);
});
