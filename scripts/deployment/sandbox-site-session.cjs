"use strict";
const assert = require("node:assert/strict");
const { openSync, fstatSync, writeSync, closeSync } = require("node:fs");

function prepareSandboxSiteSession(variables, site) {
  assert.ok(["frontend", "docs"].includes(site));
  const account = variables.AWS_ACCOUNT_ID;
  const role = variables.SANDBOX_BACKEND_DEPLOY_ROLE_ARN;
  const region = variables.AWS_REGION;
  const bucket = variables[site.toUpperCase() + "_BUCKET"];
  const distribution = variables[site.toUpperCase() + "_DISTRIBUTION_ID"];
  const selectors = [account, role, region, bucket, distribution];
  for (const value of selectors) assert.doesNotMatch(value, /\s/);
  assert.match(account, /^\d{12}$/);
  assert.match(
    role,
    new RegExp(
      "^arn:aws:iam::" +
        account +
        ":role/[a-z0-9-]*sandbox[a-z0-9-]*-github-deploy$",
    ),
  );
  assert.match(region, /^(?!cn-)[a-z]{2}-[a-z]+-[1-9]\d*$/);
  assert.match(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.ok(
    !bucket.includes("..") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(bucket) &&
      !/^(xn--|sthree-|amzn-s3-demo-)/.test(bucket) &&
      !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(bucket),
  );
  assert.match(distribution, /^E[A-Z0-9]{1,31}$/);
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objectsArn = `${bucketArn}/*`;
  const distributionArn = `arn:aws:cloudfront::${account}:distribution/${distribution}`;
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: bucketArn },
      {
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Resource: objectsArn,
      },
      {
        Effect: "Allow",
        Action: [
          "cloudfront:CreateInvalidation",
          ...(site === "docs"
            ? ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"]
            : []),
        ],
        Resource: distributionArn,
      },
      {
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "kms:CallerAccount": account,
            "kms:ViaService": `s3.${region}.amazonaws.com`,
          },
          StringLike: { "kms:EncryptionContext:aws:s3:arn": objectsArn },
        },
      },
    ],
  });
  assert.ok(Buffer.byteLength(policy) <= 2048);
  return {
    policy,
    masks: [...selectors, bucketArn, objectsArn, distributionArn, policy],
  };
}

module.exports = { prepareSandboxSiteSession };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 3);
    assert.ok(process.env.GITHUB_OUTPUT);
    const prepared = prepareSandboxSiteSession(process.env, process.argv[2]);
    const output = openSync(process.env.GITHUB_OUTPUT, "a");
    try {
      assert.ok(fstatSync(output).isFile());
      for (const value of prepared.masks)
        process.stdout.write(`::add-mask::${value}\n`);
      writeSync(output, `policy=${prepared.policy}\n`);
    } finally {
      closeSync(output);
    }
  } catch {
    process.stderr.write("Sandbox site session refused\n");
    process.exitCode = 1;
  }
}
