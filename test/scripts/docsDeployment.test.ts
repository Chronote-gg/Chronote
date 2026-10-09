/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test.each(["deploy.yml", "deploy-staging.yml"])(
  "%s validates docs in their own job and preserves asset caching",
  (name) => {
    const workflow = parse(readFileSync(`.github/workflows/${name}`, "utf8"));
    const docs = workflow.jobs["deploy-docs"].steps;
    const frontend = workflow.jobs["deploy-frontend"].steps;
    expect(
      frontend.some(
        (step: { name: string }) =>
          step.name === "Preflight docs publish targets",
      ),
    ).toBe(false);
    expect(
      docs.find(
        (step: { name: string }) =>
          step.name === "Preflight docs publish targets",
      ).if,
    ).toBe("steps.docs-config.outputs.enabled == 'true'");
    const sync = docs.find(
      (step: { name: string }) => step.name === "Sync docs to S3",
    ).run;
    const commands = sync
      .split("\n")
      .filter((line: string) => line.trim().startsWith("aws s3 sync"));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--exclude "assets/*"');
    expect(commands[0]).toContain('--cache-control "public,max-age=600"');
    expect(commands[1]).toContain(
      '/assets --delete --cache-control "public,max-age=31536000,immutable"',
    );
  },
);
