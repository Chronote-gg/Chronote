/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

test.each(["none", "ancestor", "missing", "unrelated"])(
  "Claude follow-up context uses the actual delta with %s prior review",
  (prior) => {
    const workflow = parse(
      readFileSync(".github/workflows/claude-review.yml", "utf8"),
    );
    const command = workflow.jobs.review.steps.find(
      (step: { name: string }) => step.name === "Build Claude review context",
    ).run;
    const directory = mkdtempSync(join(tmpdir(), "chronote-review-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Review fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(directory, "fixture.txt"), "base\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "earlier.txt"), "already reviewed\n");
      git("add", ".");
      git("commit", "-qm", "previous");
      const previous = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "recovery.txt"), "new recovery route\n");
      git("add", ".");
      git("commit", "-qm", "new head");
      const head = git("rev-parse", "HEAD");
      const priorSha =
        prior === "missing"
          ? "0".repeat(40)
          : prior === "unrelated"
            ? git(
                "commit-tree",
                git("rev-parse", "HEAD^{tree}"),
                "-m",
                "unrelated",
              )
            : previous;
      const priorBody =
        prior === "none" ? "" : `<!-- claude-reviewed-sha:${priorSha} -->\n`;
      execFileSync("bash", ["-c", command], {
        cwd: directory,
        env: {
          ...process.env,
          BASE_REF: "master",
          BASE_SHA: base,
          HEAD_SHA: head,
          GITHUB_REPOSITORY: "Chronote-gg/Chronote",
          PR_NUMBER: "394",
          PR_TITLE: "Review context fixture",
          PR_BODY: "Context is source material.",
          PREVIOUS_REVIEW_B64: Buffer.from(priorBody).toString("base64"),
        },
      });
      const readContext = (file: string) =>
        readFileSync(join(directory, ".claude-review", file), "utf8");
      const followUp = readContext("follow-up-diff.patch");
      expect(followUp).toContain("new recovery route");
      expect(readContext("pr-diff.patch")).toContain("already reviewed");
      if (prior === "ancestor") {
        expect(followUp).not.toContain("already reviewed");
        expect(readContext("follow-up-stat.txt")).not.toContain("earlier.txt");
        expect(readContext("pr-context.md")).toContain(previous);
        expect(readContext("pr-context.md")).toContain(head);
      } else {
        expect(followUp).toEqual(readContext("pr-diff.patch"));
        expect(readContext("pr-context.md")).toContain("No usable ancestor");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
