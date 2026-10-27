/** @jest-environment node */
import { readFileSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { parse } from "yaml";
import { test, expect } from "@jest/globals";
const deployment = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
test("frontend publication waits for the compatible backend, docs stay independent", () => {
  expect(deployment.jobs["deploy-frontend"].needs).toContain("deploybackend");
  expect(deployment.jobs["deploy-docs"].needs).toEqual(["ci"]);
  const commands = deployment.jobs.deploybackend.steps
    .map((s) => s.run ?? "")
    .join("\n");
  for (const phase of ["prepare", "promote", "retire", "reconcile"])
    expect(commands).toContain(`coordinator.cjs ${phase}`);
});
test("production backend uses scoped OIDC before image and service writes", () => {
  const job = deployment.jobs.deploybackend;
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  const auth = job.steps.findIndex((s) =>
    s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  expect(job.steps[auth].with).toMatchObject({
    "role-to-assume": "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}",
    "allowed-account-ids": "${{ vars.AWS_ACCOUNT_ID }}",
    "role-session-name":
      "chronote-production-${{ github.run_id }}-${{ github.run_attempt }}",
    "unset-current-credentials": true,
  });
  expect(job.steps[auth].with).not.toHaveProperty("aws-access-key-id");
  const identity = job.steps.findIndex((s) =>
    s.run?.includes("assert-production-identity.cjs"),
  );
  expect(identity).toBeGreaterThan(auth);
  expect(identity).toBeLessThan(
    job.steps.findIndex((s) => s.id === "build-image"),
  );
});
test("manual introduction has only the three approved dispatch inputs", () => {
  const file = ".github/workflows/production-introduction.yml";
  expect(existsSync(file)).toBe(true);
  const workflow = parse(readFileSync(file, "utf8"));
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
    "manifest_sha256",
    "operation_id",
    "phase",
  ]);
  expect(workflow.on.workflow_dispatch.inputs.phase.default).toBe("inspect");
  expect(workflow.concurrency).toEqual({
    group: "chronote-deploy-production",
    "cancel-in-progress": false,
  });
});

test("introduction jobs are read-only, freeze the hash before late private delivery, and cannot hide Terraform", () => {
  const workflow = parse(
    readFileSync(".github/workflows/production-introduction.yml", "utf8"),
  );
  expect(workflow.env).not.toHaveProperty("EXPECTED_ACCOUNT_ID");
  expect(workflow.env).not.toHaveProperty("EXPECTED_ROLE_ARN");
  expect(workflow.jobs.execute.needs).toEqual(["bind"]);
  expect(workflow.jobs.bind.outputs.sha256).toBe(
    "${{ steps.bind.outputs.sha256 }}",
  );
  for (const job of Object.values(workflow.jobs)) {
    expect(job.environment).toBe("production");
    expect(job.steps.at(-1).env).toMatchObject({
      EXPECTED_ACCOUNT_ID: "${{ vars.AWS_ACCOUNT_ID }}",
      EXPECTED_ROLE_ARN: "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}",
    });
    expect(job.if).toContain("github.run_attempt == 1");
    expect(job.if).toContain("github.ref == 'refs/heads/master'");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.steps[0].with.ref).toBe("${{ github.sha }}");
    const auth = job.steps.find((s) =>
      s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    );
    expect(auth.with["role-to-assume"]).toBe(
      "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}",
    );
    expect(auth.with["allowed-account-ids"]).toBe("${{ vars.AWS_ACCOUNT_ID }}");
    expect(auth.with["role-session-name"]).toBe(
      "chronote-production-${{ github.run_id }}-1",
    );
    expect(auth.with).not.toHaveProperty("aws-access-key-id");
    const statements = JSON.parse(auth.with["inline-session-policy"]).Statement;
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: [
          "sts:GetCallerIdentity",
          "dynamodb:GetItem",
          "ecs:DescribeServices",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: "kms:Decrypt",
        Resource: "*",
        Condition: {
          StringEquals: {
            "kms:ViaService": "dynamodb.${{ vars.AWS_REGION }}.amazonaws.com",
            "kms:CallerAccount": "${{ vars.AWS_ACCOUNT_ID }}",
          },
        },
      },
    ]);
    expect(JSON.stringify(job)).not.toMatch(
      /terraform|upload-artifact|continue-on-error|secrets\.AWS_SECRET_ACCESS_KEY/i,
    );
  }
  expect(JSON.stringify(workflow.jobs.bind)).not.toContain(
    "PRODUCTION_PHASE_ENVELOPE",
  );
  const delivery = workflow.jobs.execute.steps.at(-1);
  expect(delivery.env).toMatchObject({
    PRODUCTION_PHASE_ENVELOPE: "${{ secrets.PRODUCTION_PHASE_ENVELOPE }}",
    PRODUCTION_PHASE_EXPECTED_SHA256:
      "${{ secrets.PRODUCTION_PHASE_EXPECTED_SHA256 }}",
    BIND_SHA256: "${{ needs.bind.outputs.sha256 }}",
  });
  expect(delivery.run).toContain("production-workflow.cjs execute");
});

test.each(["deploy-docs", "deploy-frontend"])(
  "%s has only its existing site rights and normal hold guard",
  (name) => {
    const job = deployment.jobs[name];
    expect(job.environment).toBe("production");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job["timeout-minutes"]).toBe(45);
    const auth = job.steps.findIndex((s) =>
      s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    );
    expect(job.steps[auth].with).toMatchObject({
      "role-to-assume": "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}",
      "allowed-account-ids": "${{ vars.AWS_ACCOUNT_ID }}",
      "unset-current-credentials": true,
      "role-duration-seconds": 3600,
    });
    expect(job.steps[auth].with["role-session-name"]).toBe(
      "chronote-production-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    const text = job.steps[auth].with["inline-session-policy"];
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
    const policy = JSON.parse(text);
    expect(policy.Statement.flatMap((s) => s.Action).join(" ")).not.toMatch(
      /ecs:|iam:|PassRole|UpdateItem|PutItem|GetObject|DeleteObjectVersion/,
    );
    expect(
      policy.Statement.find((s) => s.Action.includes("dynamodb:GetItem"))
        .Condition,
    ).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["ENV"] },
    });
    expect(
      policy.Statement.filter((s) => s.Action.includes("kms:Decrypt")),
    ).toHaveLength(2);
    const identity = job.steps.findIndex((s) =>
      s.run?.includes("assert-production-identity.cjs"),
    );
    expect(identity).toBeGreaterThan(auth);
    const writes = job.steps
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          s.uses === "./.github/actions/sync-frontend" ||
          /aws s3 sync|cloudfront create-invalidation/.test(s.run ?? ""),
      );
    expect(writes.length).toBeGreaterThan(0);
    for (const { s, i } of writes) {
      const own = s.run ?? "";
      const preceding = job.steps
        .slice(identity + 1, i)
        .some(
          (p) =>
            p.run?.trim() ===
            "node scripts/deployment/production-writer-guard.cjs",
        );
      expect(
        preceding ||
          own.includes("node scripts/deployment/production-writer-guard.cjs"),
      ).toBe(true);
      expect(own).not.toContain("--inspect");
    }
  },
);

test("frontend invalidation does not print provider response while upload caching stays unchanged", () => {
  const action = parse(
    readFileSync(".github/actions/sync-frontend/action.yml", "utf8"),
  );
  expect(action.runs.steps.at(-1).run).toContain(
    "--query 'Invalidation.Id' --output text >/dev/null",
  );
  expect(action.runs.steps[0].run).toContain(
    '--cache-control "public,max-age=31536000,immutable"',
  );
  expect(action.runs.steps[0].run).toContain(
    '--cache-control "public,max-age=600"',
  );
});
