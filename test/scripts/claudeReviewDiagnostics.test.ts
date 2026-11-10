/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
const step = () =>
  parse(
    readFileSync(".github/workflows/claude-review.yml", "utf8"),
  ).jobs.review.steps.find(
    (s: { name: string }) => s.name === "Extract Claude review Markdown",
  );
test("Claude failure diagnostics run after a failed action without running on cancellation", () => {
  expect(step().if).toContain("always() && !cancelled()");
  expect(step().if).toContain("steps.claude_review.outcome == 'failure'");
});
test.each([
  ["You've hit your limit. PRIVATE_ERROR_SENTINEL", "usage_limit_message"],
  ["Invalid API key. PRIVATE_ERROR_SENTINEL", "authentication_message"],
  ["Unexpected PRIVATE_ERROR_SENTINEL", "unclassified"],
])(
  "Claude diagnostic classifies failure without publishing private text",
  (message, kind) => {
    const command = step().run;
    const script = command.match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
    if (!script) throw Error("Review diagnostic Node block missing");
    const directory = mkdtempSync(
      join(tmpdir(), "chronote-review-diagnostic-"),
    );
    try {
      const input = join(directory, "execution.json"),
        output = join(directory, "review.md");
      writeFileSync(
        input,
        JSON.stringify([
          {
            type: "result",
            subtype: "success",
            is_error: true,
            num_turns: 1,
            duration_ms: 443,
            total_cost_usd: 0,
            result: message,
          },
        ]),
      );
      const result = spawnSync(process.execPath, ["-", input, output], {
        input: script,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`failure_kind=${kind}`);
      expect(result.stdout + result.stderr).not.toContain(
        "PRIVATE_ERROR_SENTINEL",
      );
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
