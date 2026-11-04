"use strict";
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
function buildPublicationRelease(prior, image) {
  const digest = image.replace(/^.*@/, ""),
    images = prior ?? [];
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    !Array.isArray(images) ||
    images.length > 1024 ||
    images.some(
      (v) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v),
    )
  )
    throw Error("Invalid immutable release metadata");
  return {
    contract: "first_publication_archive_fence_v1",
    images: [...new Set([...images, digest])],
  };
}
if (require.main === module) {
  const table =
    process.env.DEPLOYMENT_CONTROL_TABLE ||
    process.env.SECRETS_PREFIX + "-DeploymentControlTable";
  if (!process.env.CANDIDATE_IMAGE || !process.env.AWS_REGION)
    throw Error("Release environment unavailable");
  const raw = JSON.parse(
    execFileSync(
      "aws",
      [
        "dynamodb",
        "get-item",
        "--table-name",
        table,
        "--key",
        JSON.stringify({ pk: { S: "ENV" }, sk: { S: "CONTROL" } }),
        "--consistent-read",
        "--region",
        process.env.AWS_REGION,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      { encoding: "utf8", env: { ...process.env, AWS_MAX_ATTEMPTS: "1" } },
    ),
  );
  const row = raw.Item ? unmarshall(raw.Item) : {};
  writeFileSync(
    "scripts/operator/recovery-publication-releases.json",
    JSON.stringify(
      buildPublicationRelease(
        row.publicationCompatibleImages,
        process.env.CANDIDATE_IMAGE,
      ),
      null,
      2,
    ) + "\n",
  );
}
module.exports = { buildPublicationRelease };
