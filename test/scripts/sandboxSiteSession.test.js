/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { prepareSandboxSiteSession } from "../../scripts/deployment/sandbox-site-session.cjs";

function fixture(site) {
  return {
    AWS_ACCOUNT_ID: "123456789012",
    SANDBOX_BACKEND_DEPLOY_ROLE_ARN:
      "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy",
    AWS_REGION: "us-east-1",
    [site.toUpperCase() + "_BUCKET"]:
      `meeting-notes-sandbox-${site}-123456789012`,
    [site.toUpperCase() + "_DISTRIBUTION_ID"]: "ESYNTHETIC12345",
  };
}

test.each(["frontend", "docs"])(
  "%s permits only its own publishing operations",
  (site) => {
    const variables = fixture(site);
    const bucket = variables[site.toUpperCase() + "_BUCKET"];
    const bucketArn = `arn:aws:s3:::${bucket}`;
    const prepared = prepareSandboxSiteSession(variables, site);
    expect(JSON.parse(prepared.policy)).toEqual({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: bucketArn },
        {
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:AbortMultipartUpload",
          ],
          Resource: `${bucketArn}/*`,
        },
        {
          Effect: "Allow",
          Action: [
            "cloudfront:CreateInvalidation",
            ...(site === "docs"
              ? ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"]
              : []),
          ],
          Resource:
            "arn:aws:cloudfront::123456789012:distribution/ESYNTHETIC12345",
        },
        {
          Effect: "Allow",
          Action: ["kms:GenerateDataKey", "kms:Decrypt"],
          Resource: "*",
          Condition: {
            StringEquals: {
              "kms:CallerAccount": variables.AWS_ACCOUNT_ID,
              "kms:ViaService": "s3.us-east-1.amazonaws.com",
            },
            StringLike: {
              "kms:EncryptionContext:aws:s3:arn": `${bucketArn}/*`,
            },
          },
        },
      ],
    });
    expect(Buffer.byteLength(prepared.policy)).toBeLessThanOrEqual(2048);
    expect(prepared.policy).not.toMatch(/ecs:|iam:|secretsmanager:|\$\{\{/);
    expect(prepared.policy).not.toContain(
      site === "docs" ? "sandbox-frontend" : "sandbox-docs",
    );
    expect(prepared.masks).toEqual(
      expect.arrayContaining([
        ...Object.values(variables),
        bucketArn,
        `${bucketArn}/*`,
        "arn:aws:cloudfront::123456789012:distribution/ESYNTHETIC12345",
        prepared.policy,
      ]),
    );
  },
);

test.each(["frontend", "docs"])(
  "%s preserves a valid custom bucket",
  (site) => {
    const variables = fixture(site);
    variables[site.toUpperCase() + "_BUCKET"] =
      `chronote-custom-${site}.archive`;
    const prepared = prepareSandboxSiteSession(variables, site);
    expect(prepared.policy).toContain(
      `arn:aws:s3:::chronote-custom-${site}.archive/*`,
    );
    expect(prepared.masks).toContain(`chronote-custom-${site}.archive`);
  },
);

test("uses the configured account, Sandbox role and region without deployment constants", () => {
  const variables = {
    ...fixture("docs"),
    AWS_ACCOUNT_ID: "999999999999",
    SANDBOX_BACKEND_DEPLOY_ROLE_ARN:
      "arn:aws:iam::999999999999:role/custom-sandbox-github-deploy",
    AWS_REGION: "eu-west-1",
  };
  const policy = JSON.parse(
    prepareSandboxSiteSession(variables, "docs").policy,
  );
  expect(policy.Statement[2].Resource).toBe(
    "arn:aws:cloudfront::999999999999:distribution/ESYNTHETIC12345",
  );
  expect(policy.Statement[3].Condition.StringEquals).toEqual({
    "kms:CallerAccount": "999999999999",
    "kms:ViaService": "s3.eu-west-1.amazonaws.com",
  });
});

test.each([
  ["AWS_ACCOUNT_ID", "wrong"],
  ["AWS_ACCOUNT_ID", "123456789012\n"],
  ["AWS_ACCOUNT_ID", "999999999999"],
  ["SANDBOX_BACKEND_DEPLOY_ROLE_ARN", "arn:aws:iam::123456789012:root"],
  [
    "SANDBOX_BACKEND_DEPLOY_ROLE_ARN",
    "arn:aws:iam::123456789012:role/meeting-notes-prod-github-deploy",
  ],
  [
    "SANDBOX_BACKEND_DEPLOY_ROLE_ARN",
    "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy\n",
  ],
  ["AWS_REGION", "wrong"],
  ["AWS_REGION", "us-east-1\n"],
  ["AWS_REGION", "cn-north-1"],
  ["AWS_REGION", "us-gov-west-1"],
  ["AWS_REGION", "${{ vars.AWS_REGION }}"],
  ["DOCS_DISTRIBUTION_ID", "bad/distribution"],
  ["DOCS_DISTRIBUTION_ID", "A12345"],
  ["DOCS_DISTRIBUTION_ID", "e12345"],
  ["DOCS_DISTRIBUTION_ID", "E" + "A".repeat(32)],
  ["DOCS_DISTRIBUTION_ID", "${{ vars.DOCS_DISTRIBUTION_ID }}"],
  ["DOCS_DISTRIBUTION_ID", "ESYNTHETIC\n"],
  ...[
    "BadBucket",
    "ab",
    "bad/bucket",
    "bad*bucket",
    "bad..bucket",
    "127.0.0.1",
    "bucket\n",
    "xn--bucket",
    "bucket-s3alias",
    "bucket--ol-s3",
    "bucket.mrap",
    "bucket--x-s3",
    "bucket--table-s3",
    "sthree-bucket",
    "amzn-s3-demo-bucket",
    "a".repeat(64),
  ].map((value) => ["DOCS_BUCKET", value]),
  ...Object.keys(fixture("docs")).map((name) => [name, undefined]),
])("refuses invalid or missing %s", (name, value) => {
  expect(() =>
    prepareSandboxSiteSession({ ...fixture("docs"), [name]: value }, "docs"),
  ).toThrow();
});

test.each(["frontend", "docs"])(
  "%s policy stays within the STS limit at maximum selector lengths",
  (site) => {
    const variables = fixture(site);
    variables[site.toUpperCase() + "_BUCKET"] = "a".repeat(63);
    variables[site.toUpperCase() + "_DISTRIBUTION_ID"] = "E" + "A".repeat(31);
    const prepared = prepareSandboxSiteSession(variables, site);
    expect(Buffer.byteLength(prepared.policy)).toBeLessThanOrEqual(2048);
    expect(prepared.policy).toContain("a".repeat(63));
  },
);

test("refuses an unknown site", () => {
  expect(() => prepareSandboxSiteSession(fixture("docs"), "other")).toThrow();
});

test.each([[], ["other"], ["docs", "extra"], ["docs"]])(
  "CLI failure discloses only a fixed refusal and no policy for %j",
  (...args) => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-site-refusal-"));
    const output = join(directory, "output");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/deployment/sandbox-site-session.cjs", ...args],
        {
          env: {
            ...process.env,
            ...fixture("docs"),
            DOCS_BUCKET: "private-invalid/bucket",
            GITHUB_OUTPUT: output,
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Sandbox site session refused\n");
      expect(() => readFileSync(output)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["frontend", "docs"])(
  "%s CLI masks selectors and policy and writes the prepared output",
  (site) => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-site-session-"));
    try {
      const output = join(directory, "output");
      const variables = fixture(site);
      const prepared = prepareSandboxSiteSession(variables, site);
      const result = spawnSync(
        process.execPath,
        ["scripts/deployment/sandbox-site-session.cjs", site],
        {
          env: { ...process.env, ...variables, GITHUB_OUTPUT: output },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        prepared.masks.map((value) => `::add-mask::${value}\n`).join(""),
      );
      expect(readFileSync(output, "utf8")).toBe(`policy=${prepared.policy}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["missing", "directory"])(
  "CLI refuses a %s output file before emitting masks",
  (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-site-output-"));
    const env = {
      ...process.env,
      ...fixture("docs"),
      GITHUB_OUTPUT: directory,
    };
    if (mode === "missing") delete env.GITHUB_OUTPUT;
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/deployment/sandbox-site-session.cjs", "docs"],
        { env, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Sandbox site session refused\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
