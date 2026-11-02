/** @jest-environment node */
import process from "node:process";
import { test, expect } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { verifyMeetingUpdatePlan } from "../../scripts/deployment/terraform-meeting-update.cjs";
import {
  nativeMeetingPlan,
  nativeEvidence,
} from "../fixtures/deployment/terraformMeetingNative.js";
import { identity } from "../fixtures/deployment/terraformMeetingUpdate.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
function render(values, vars = {}, secrets = {}) {
  const directory = mkdtempSync(join(tmpdir(), "terraform-tfvars-"));
  mkdirSync(join(directory, "_infra"));
  try {
    const result = spawnSync(
      "python",
      [resolve("scripts/deployment/terraform-tfvars.py")],
      {
        cwd: directory,
        stdio: "pipe",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TERRAFORM_TFVARS_JSON: JSON.stringify(values),
          GITHUB_VARS_JSON:
            typeof vars === "string" ? vars : JSON.stringify(vars),
          ...secrets,
        },
      },
    );
    const output = join(directory, "_infra/terraform.auto.tfvars.json");
    return {
      status: result.status,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      exists: existsSync(output),
      values: existsSync(output)
        ? JSON.parse(readFileSync(output, "utf8"))
        : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function run(values, vars = {}, secrets = {}) {
  const result = render(values, vars, secrets);
  if (result.status !== 0) throw new Error("Renderer refused");
  return result.values;
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
  ["false", false],
  ["true", true],
  [" \tfalse\n", false],
  [" \ttrue\n", true],
])("declared retry flag %j renders as boolean %s", (value, expected) => {
  expect(
    run(valid, { TFVAR_ENABLE_PROCESSING_RETRY_INDEX: value })
      .ENABLE_PROCESSING_RETRY_INDEX,
  ).toBe(expected);
});

test.each(["", " \t\n"])(
  "empty retry flag %j preserves the base value",
  (value) => {
    expect(
      run(
        { ...valid, ENABLE_PROCESSING_RETRY_INDEX: true },
        { TFVAR_ENABLE_PROCESSING_RETRY_INDEX: value },
      ).ENABLE_PROCESSING_RETRY_INDEX,
    ).toBe(true);
    expect(
      run(valid, { TFVAR_ENABLE_PROCESSING_RETRY_INDEX: value }),
    ).not.toHaveProperty("ENABLE_PROCESSING_RETRY_INDEX");
  },
);

test.each([
  "False",
  "TRUE",
  "yes",
  "0",
  "1",
  "null",
  '"false"',
  "[]",
  "{}",
  "[PRIVATE_SENTINEL",
  "PRIVATE_SENTINEL",
  false,
  null,
  [],
  {},
])("invalid retry flag %j refuses without logging values", (value) => {
  const result = render(valid, { TFVAR_ENABLE_PROCESSING_RETRY_INDEX: value });
  expect(result.status).not.toBe(0);
  expect(result.exists).toBe(false);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(
    "Invalid declared Terraform boolean; values are not logged.",
  );
});

test("rendered retry opt-out passes the full native delivery verifier", () => {
  const values = run(valid, { TFVAR_ENABLE_PROCESSING_RETRY_INDEX: "false" });
  const plan = nativeMeetingPlan();
  plan.variables.ENABLE_PROCESSING_RETRY_INDEX.value =
    values.ENABLE_PROCESSING_RETRY_INDEX;
  expect(() =>
    verifyMeetingUpdatePlan(plan, identity, nativeEvidence(plan)),
  ).not.toThrow();
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

const collections = {
  production_introduction_task_definitions: [
    "definition-one",
    "definition-two",
  ],
  production_introduction_standalone_tasks: ["task-one"],
  production_acceptance_fixtures: [
    { guild_id: "guild", voice_channel_id: "voice", meeting_id: "meeting" },
  ],
};
test.each([false, true])(
  "declared collection variables retain JSON types with uppercase aliases %s",
  (upper) => {
    const vars = Object.fromEntries(
      Object.entries(collections).map(([key, value]) => [
        "TFVAR_" + (upper ? key.toUpperCase() : key),
        JSON.stringify(value),
      ]),
    );
    vars[
      "TFVAR_" +
        (upper
          ? "ENABLE_PRODUCTION_INTRODUCTION_ROLES"
          : "enable_production_introduction_roles")
    ] = "true";
    vars.TFVAR_ENABLE_PRODUCTION_ACCEPTANCE_COLLECTOR = "false";
    vars.TFVAR_ENABLE_PRODUCTION_PROMPT_GUARD_ROLE = "true";
    expect(run(valid, vars)).toMatchObject({
      ...collections,
      enable_production_introduction_roles: "true",
      enable_production_acceptance_collector: "false",
      enable_production_prompt_guard_role: "true",
    });
  },
);
test("uppercase GitHub distribution variables reach the lowercase Terraform inputs", () => {
  expect(
    run(valid, {
      TFVAR_FRONTEND_DISTRIBUTION_ID: "EFRONTEND1",
      TFVAR_DOCS_DISTRIBUTION_ID: "EDOCS2",
    }),
  ).toMatchObject({
    frontend_distribution_id: "EFRONTEND1",
    docs_distribution_id: "EDOCS2",
  });
});
test("unselected scalar variables keep their exact suffix and string behavior", () => {
  expect(
    run(valid, { TFVAR_other_input: '["literal"]', TFVAR_OTHER_INPUT: "TRUE" }),
  ).toMatchObject({ other_input: '["literal"]', OTHER_INPUT: "TRUE" });
});
test.each([
  ["production_introduction_task_definitions", "null"],
  ["production_introduction_standalone_tasks", '"PRIVATE_SENTINEL"'],
  ["production_introduction_task_definitions", '["PRIVATE_SENTINEL",1]'],
  ["production_introduction_task_definitions", '["PRIVATE_SENTINEL"'],
  ["production_acceptance_fixtures", '["PRIVATE_SENTINEL"]'],
  [
    "production_acceptance_fixtures",
    '[{"guild_id":"PRIVATE_SENTINEL","voice_channel_id":"v"}]',
  ],
  [
    "production_acceptance_fixtures",
    '[{"guild_id":"PRIVATE_SENTINEL","voice_channel_id":"v","meeting_id":1}]',
  ],
  [
    "production_acceptance_fixtures",
    '[{"guild_id":"PRIVATE_SENTINEL","voice_channel_id":"v","meeting_id":"m","extra":"x"}]',
  ],
  [
    "production_acceptance_fixtures",
    '[{"guild_id":"PRIVATE_SENTINEL","guild_id":"other","voice_channel_id":"v","meeting_id":"m"}]',
  ],
])(
  "invalid declared collection %s refuses before output without payload disclosure",
  (key, value) => {
    const result = render(valid, { ["TFVAR_" + key]: value });
    expect(result.status).not.toBe(0);
    expect(result.exists).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SENTINEL");
  },
);
test.each([
  '{"TFVAR_PRODUCTION_INTRODUCTION_TASK_DEFINITIONS":"[]","TFVAR_production_introduction_task_definitions":"[]"}',
  '{"TFVAR_ENABLE_PRODUCTION_INTRODUCTION_ROLES":"true","TFVAR_enable_production_introduction_roles":"false"}',
  '{"TFVAR_production_acceptance_fixtures":"[]","TFVAR_production_acceptance_fixtures":"[]"}',
])("ambiguous declared input refuses before writing", (vars) => {
  const result = render(valid, vars);
  expect(result.status).not.toBe(0);
  expect(result.exists).toBe(false);
});
test("credential refusal precedes collection decoding and does not disclose either value", () => {
  const result = render(valid, {
    TFVAR_PRODUCTION_ACCEPTANCE_FIXTURES: "[PRIVATE_SENTINEL",
    TFVAR_GITHUB_TOKEN: "CREDENTIAL_SENTINEL",
  });
  expect(result.status).not.toBe(0);
  expect(result.exists).toBe(false);
  expect(result.stderr).toContain("credential");
  expect(result.stdout + result.stderr).not.toMatch(
    /CREDENTIAL_SENTINEL|PRIVATE_SENTINEL/,
  );
});
