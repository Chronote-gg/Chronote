/** @jest-environment node */
import process from "node:process";
import { test, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
function run(values, vars = {}, secrets = {}) {
  const directory = mkdtempSync(join(tmpdir(), "terraform-tfvars-"));
  mkdirSync(join(directory, "_infra"));
  try {
    execFileSync(
      "python",
      [resolve("scripts/deployment/terraform-tfvars.py")],
      {
        cwd: directory,
        stdio: "pipe",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TERRAFORM_TFVARS_JSON: JSON.stringify(values),
          GITHUB_VARS_JSON: JSON.stringify(vars),
          ...secrets,
        },
      },
    );
    return JSON.parse(
      readFileSync(
        join(directory, "_infra/terraform.auto.tfvars.json"),
        "utf8",
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const valid = {
  GITHUB_TOKEN: "fake",
  AWS_TOKEN_KEY: "old",
  DISCORD_CLIENT_ID: ["", "123"],
  SUPER_ADMIN_USER_IDS: ["456"],
  grafana_api_key: "",
  grafana_url: "https://synthetic.invalid",
  grafana_service_account_id: "7",
};
test("moved tfvars normalizes one string and preserves approved credential overlays", () => {
  const values = run(
    valid,
    { TFVAR_ENABLE_ONBOARDING: " true ", OTHER: "ignored" },
    {
      AWS_ACCESS_KEY_ID: "new",
      REDIS_AUTH_TOKEN: "token",
      REDIS_URL: "rediss://synthetic.invalid",
    },
  );
  expect(values).toMatchObject({
    AWS_TOKEN_KEY: "new",
    DISCORD_CLIENT_ID: "123",
    SUPER_ADMIN_USER_IDS: "456",
    ENABLE_ONBOARDING: "true",
    REDIS_AUTH_TOKEN: "token",
    REDIS_URL: "rediss://synthetic.invalid",
  });
  expect(values).not.toHaveProperty("OTHER");
});
test.each([
  "GITHUB_TOKEN",
  "AWS_TOKEN_KEY",
  "LANGFUSE_SECRET_KEY",
  "DOCS_ALGOLIA_API_KEY",
  "REDIS_AUTH_TOKEN",
  "REDIS_URL",
  "grafana_api_key",
])("TFVAR credential override %s refuses", (key) => {
  expect(() => run(valid, { ["TFVAR_" + key]: "fake" })).toThrow();
});
test.each([
  { GITHUB_TOKEN: "" },
  { DISCORD_CLIENT_ID: ["123", "456"] },
  { grafana_api_key: "not-empty" },
  { grafana_service_account_id: "" },
])("tfvars rejects invalid required, type or Grafana values %s", (patch) => {
  expect(() => run({ ...valid, ...patch })).toThrow();
});
