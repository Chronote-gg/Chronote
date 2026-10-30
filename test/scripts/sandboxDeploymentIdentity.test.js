/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import process from "node:process";

const role =
  "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy";
const session = "chronote-sandbox-123-1";
const identity = {
  Account: "123456789012",
  Arn:
    "arn:aws:sts::123456789012:assumed-role/meeting-notes-sandbox-github-deploy/" +
    session,
};
const env = {
  ...process.env,
  EXPECTED_ACCOUNT_ID: "123456789012",
  EXPECTED_ROLE_ARN: role,
  EXPECTED_SESSION_NAME: session,
};

test("accepts the exact Sandbox role session", () => {
  expect(
    execFileSync("node", ["scripts/deployment/assert-sandbox-identity.cjs"], {
      env,
      input: JSON.stringify(identity),
      encoding: "utf8",
    }).trim(),
  ).toBe("Sandbox deployment identity verified");
});

test.each([
  { ...identity, Account: "999999999999" },
  { ...identity, Arn: "arn:aws:iam::123456789012:root" },
  { ...identity, Arn: identity.Arn.replace("sandbox", "prod") },
  { ...identity, Arn: identity.Arn + "-other" },
])(
  "refuses a foreign account, role or session without exposing it",
  (actor) => {
    try {
      execFileSync("node", ["scripts/deployment/assert-sandbox-identity.cjs"], {
        env,
        input: JSON.stringify(actor),
        stdio: ["pipe", "pipe", "pipe"],
      });
      throw new Error("identity was accepted");
    } catch (error) {
      expect(error.stderr.toString()).toBe(
        "Sandbox deployment identity mismatch\n",
      );
      expect(error.status).toBe(1);
    }
  },
);

test("backend uses OIDC and validates identity before any image or service write", () => {
  const workflow = parse(
    readFileSync(".github/workflows/deploy-staging.yml", "utf8"),
  );
  const backend = workflow.jobs.deploybackend;
  expect(backend.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
  expect(backend.environment).toBe("sandbox");
  const auth = backend.steps.findIndex((step) =>
    step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  expect(backend.steps[auth].with).toMatchObject({
    "role-to-assume": "${{ vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN }}",
    "allowed-account-ids": "${{ vars.AWS_ACCOUNT_ID }}",
    "role-duration-seconds": 10800,
    "unset-current-credentials": true,
  });
  expect(backend.steps[auth].with).not.toHaveProperty("aws-access-key-id");
  expect(backend.steps[auth].with).not.toHaveProperty("aws-secret-access-key");
  const check = backend.steps.findIndex((step) =>
    step.run?.includes("assert-sandbox-identity.cjs"),
  );
  const image = backend.steps.findIndex((step) => step.id === "build-image");
  expect(check).toBeGreaterThan(auth);
  expect(check).toBeLessThan(image);
  expect(backend["timeout-minutes"]).toBe(180);
});

test.each(["frontend", "docs"])(
  "%s uses a scoped OIDC session and validates identity before publishing",
  (site) => {
    const workflow = parse(
      readFileSync(".github/workflows/deploy-staging.yml", "utf8"),
    );
    const job = workflow.jobs[`deploy-${site}`];
    expect(job.environment).toBe("sandbox");
    expect(job.needs).toEqual(["deploy-target-preflight"]);
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const preparation = job.steps.findIndex(
      (step) => step.id === "site-session",
    );
    const auth = job.steps.findIndex((step) =>
      step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    );
    const check = job.steps.findIndex((step) =>
      step.run?.includes("assert-sandbox-identity.cjs"),
    );
    const provider = job.steps.findIndex(
      (step) =>
        step.run?.match(/aws (s3|s3api|cloudfront) /) ||
        step.uses === "./.github/actions/sync-frontend",
    );
    expect(preparation).toBeGreaterThan(-1);
    expect(job.steps[preparation].run).toBe(
      `node scripts/deployment/sandbox-site-session.cjs ${site}`,
    );
    expect(job.steps[preparation].env).toEqual({
      AWS_ACCOUNT_ID: "${{ vars.AWS_ACCOUNT_ID }}",
      SANDBOX_BACKEND_DEPLOY_ROLE_ARN:
        "${{ vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN }}",
      AWS_REGION: "${{ vars.AWS_REGION }}",
      [site.toUpperCase() + "_BUCKET"]:
        `\${{ vars.${site.toUpperCase()}_BUCKET }}`,
      [site.toUpperCase() + "_DISTRIBUTION_ID"]:
        `\${{ vars.${site.toUpperCase()}_DISTRIBUTION_ID }}`,
    });
    expect(auth).toBeGreaterThan(preparation);
    expect(job.steps[auth].with).toEqual({
      "role-to-assume": "${{ vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN }}",
      "allowed-account-ids": "${{ vars.AWS_ACCOUNT_ID }}",
      "role-session-name":
        "chronote-sandbox-${{ github.run_id }}-${{ github.run_attempt }}",
      "role-duration-seconds": 3600,
      "aws-region": "${{ vars.AWS_REGION }}",
      "unset-current-credentials": true,
      "mask-aws-account-id": true,
      "inline-session-policy": "${{ steps.site-session.outputs.policy }}",
    });
    expect(check).toBeGreaterThan(auth);
    expect(check).toBeLessThan(provider);
    expect(job.steps[check].env).toEqual({
      EXPECTED_ACCOUNT_ID: "${{ vars.AWS_ACCOUNT_ID }}",
      EXPECTED_ROLE_ARN: "${{ vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN }}",
      EXPECTED_SESSION_NAME: job.steps[auth].with["role-session-name"],
    });
    expect(job.steps[check].run).toContain(
      "set -euo pipefail\naws sts get-caller-identity --output json | node scripts/deployment/assert-sandbox-identity.cjs",
    );
    expect(JSON.stringify(job)).not.toMatch(
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
    );
    if (site === "docs") {
      for (const index of [preparation, auth, check])
        expect(job.steps[index].if).toBe(
          "steps.docs-config.outputs.enabled == 'true'",
        );
    }
  },
);

test("Sandbox preflight requires OIDC selectors instead of static credentials", () => {
  const workflow = parse(
    readFileSync(".github/workflows/deploy-staging.yml", "utf8"),
  );
  const preflight = workflow.jobs["deploy-target-preflight"];
  expect(preflight.env.AWS_ACCOUNT_ID).toBe("${{ vars.AWS_ACCOUNT_ID }}");
  expect(preflight.env.SANDBOX_BACKEND_DEPLOY_ROLE_ARN).toBe(
    "${{ vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN }}",
  );
  const script = preflight.steps[0].run;
  const required = script.split("required_names=(")[1].split(")")[0];
  expect(required).toMatch(/\bAWS_ACCOUNT_ID\b/);
  expect(required).toMatch(/\bSANDBOX_BACKEND_DEPLOY_ROLE_ARN\b/);
  expect(JSON.stringify(preflight)).not.toMatch(
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
  );
  expect(script).toContain('[[ "$normalized" == *"prod"* ]]');
  expect(script).toContain('[[ "$normalized" == "https://api.chronote.gg"* ]]');
});

test.each([
  [{}, 0],
  [{ AWS_ACCOUNT_ID: "" }, 1],
  [{ SANDBOX_BACKEND_DEPLOY_ROLE_ARN: "" }, 1],
  [{ FRONTEND_BUCKET: "meeting-notes-prod-frontend" }, 1],
  [{ VITE_API_BASE_URL: "https://api.chronote.gg" }, 1],
])(
  "Sandbox preflight enforces configuration and target guards without static keys: %j",
  (overrides, status) => {
    const preflight = parse(
      readFileSync(".github/workflows/deploy-staging.yml", "utf8"),
    ).jobs["deploy-target-preflight"].steps[0].run;
    try {
      const output = execFileSync("bash", ["-c", preflight], {
        env: {
          ...process.env,
          AWS_ACCOUNT_ID: "123456789012",
          SANDBOX_BACKEND_DEPLOY_ROLE_ARN: role,
          AWS_REGION: "us-east-1",
          ECR_REPOSITORY: "meeting-notes-sandbox",
          ECS_CLUSTER: "meeting-notes-sandbox",
          ECS_SERVICE: "meeting-notes-sandbox",
          ECS_TASK_FAMILY: "meeting-notes-sandbox",
          ECS_LOG_GROUP: "meeting-notes-sandbox",
          FRONTEND_BUCKET: "meeting-notes-sandbox-frontend",
          FRONTEND_DISTRIBUTION_ID: "ESYNTHETIC12345",
          DOCS_BUCKET: "",
          SECRETS_PREFIX: "meeting-notes-sandbox",
          VITE_API_BASE_URL: "https://sandbox.example.test",
          AWS_ACCESS_KEY_ID: "",
          AWS_SECRET_ACCESS_KEY: "",
          ...overrides,
        },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(status).toBe(0);
      expect(output).toBe("Sandbox deploy target preflight passed.\n");
    } catch (error) {
      expect(error.status).toBe(status);
      expect(error.stdout.toString()).toContain("ERROR: sandbox deploy");
    }
  },
);

test("identity canary cannot publish images or change services", () => {
  const workflow = parse(
    readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
  );
  expect(workflow.concurrency.group).toBe("chronote-deploy-sandbox");
  const job = workflow.jobs.identity;
  expect(job.environment).toBe("sandbox");
  const auth = job.steps.find((step) =>
    step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  const policy = JSON.parse(auth.with["inline-session-policy"]);
  expect(policy.Statement).toHaveLength(1);
  expect(policy.Statement[0].Action).toBe("ecs:DescribeServices");
  expect(policy.Statement[0].Resource).toContain(":service/");
  expect(auth.with).not.toHaveProperty("aws-access-key-id");
});

test.each([
  "EXPECTED_ACCOUNT_ID",
  "EXPECTED_ROLE_ARN",
  "EXPECTED_SESSION_NAME",
])("missing %s refuses authentication", (key) => {
  const incomplete = { ...env };
  delete incomplete[key];
  expect(() =>
    execFileSync("node", ["scripts/deployment/assert-sandbox-identity.cjs"], {
      env: incomplete,
      input: JSON.stringify(identity),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  ).toThrow();
});

const canaryRead = parse(
  readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
).jobs.identity.steps.find(
  (step) => step.name === "Read Sandbox service counts",
).run;
const sandboxService = {
  serviceName: "meeting-notes-sandbox-bot-service",
  desiredCount: 0,
  runningCount: 0,
  pendingCount: 0,
};
function runCanary(response) {
  return execFileSync(
    "bash",
    [
      "-c",
      `aws() { if [[ "$*" == *"--query"* ]]; then printf '%s' null; else printf '%s' "$TEST_RESPONSE"; fi; }; ${canaryRead}`,
    ],
    {
      env: {
        ...process.env,
        TEST_RESPONSE: JSON.stringify(response),
        ECS_SERVICE: sandboxService.serviceName,
        ECS_CLUSTER: "meeting-notes-sandbox-bot-cluster",
      },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}
test("canary accepts a visible parked Sandbox service", () => {
  expect(
    JSON.parse(runCanary({ services: [sandboxService], failures: [] })),
  ).toEqual({ desired: 0, running: 0, pending: 0 });
});
test.each([
  { services: [], failures: [{ arn: "private-resource", reason: "MISSING" }] },
  { services: [], failures: [] },
  {
    services: [{ ...sandboxService, serviceName: "foreign-service" }],
    failures: [],
  },
])("canary refuses missing or wrong service evidence", (response) => {
  expect(() => runCanary(response)).toThrow();
});
