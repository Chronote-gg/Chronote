/** @jest-environment node */
import { readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";
import { parse } from "yaml";

const workflow = (name) =>
  parse(readFileSync(`.github/workflows/terraform-${name}.yml`, "utf8"));

test("only an enabled projection builds a package before the saved plan", () => {
  const steps = workflow("plan").jobs.plan.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  expect(index("Write tfvars")).toBeLessThan(
    index("Read search projection setting"),
  );
  expect(steps[index("Read search projection setting")].run).toContain(
    'get("ENABLE_SEARCH_PROJECTION", False)',
  );
  for (const name of [
    "Setup Node.js for search projection",
    "Install search projection build dependencies",
    "Build reviewed search projection package",
  ]) {
    expect(steps[index(name)].if).toBe(
      "steps.search-projection.outputs.enabled == 'true'",
    );
    expect(index(name)).toBeLessThan(index("Plan"));
  }
});

test("the search zip travels inside the encrypted reviewed plan and is never rebuilt by Apply", () => {
  const steps = workflow("plan").jobs.plan.steps;
  const archive = readFileSync("_infra/search.tf", "utf8");
  expect(archive).toContain(
    'output_path = "${path.module}/search_projection.zip"',
  );
  const encrypt = steps.find((step) => step.name === "Encrypt plan").run;
  expect(encrypt).toContain(
    'tar -czf "$RUNNER_TEMP/plan.tgz" tfplan $(ls *.zip 2>/dev/null)',
  );
  expect(encrypt).toContain("openssl enc -aes-256-cbc");
  const apply = workflow("apply").jobs.apply.steps;
  expect(
    apply.some((step) => /build-projection|yarn|npm/.test(step.run ?? "")),
  ).toBe(false);
  expect(
    apply.find((step) => step.name === "Verify and decrypt plan").run,
  ).toContain("tar -xz -C _infra");
});
