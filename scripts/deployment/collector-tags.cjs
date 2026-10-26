"use strict";
const assert = require("node:assert/strict");
const { collectPages } = require("./collector-inventory.cjs");
async function nativeTags(aws, m, arn) {
  const service = arn.split(":")[2];
  switch (service) {
    case "iam":
      return (
        await collectPages(
          aws,
          m,
          "iam",
          "list-role-tags",
          { RoleName: arn.split("/").at(-1) },
          "Tags",
          "Marker",
          "Marker",
        )
      ).rows;
    case "ecs":
      return (await aws("ecs", "list-tags-for-resource", { resourceArn: arn }))
        .tags;
    case "dynamodb":
      return (
        await collectPages(
          aws,
          m,
          "dynamodb",
          "list-tags-of-resource",
          { ResourceArn: arn },
          "Tags",
        )
      ).rows;
    case "elasticloadbalancing": {
      const result = await aws("elbv2", "describe-tags", {
        ResourceArns: [arn],
      });
      assert.equal(result.TagDescriptions.length, 1);
      assert.equal(result.TagDescriptions[0].ResourceArn, arn);
      return result.TagDescriptions[0].Tags;
    }
    case "s3":
      return (
        await aws("s3api", "get-bucket-tagging", {
          Bucket: arn.split(":::")[1],
          ExpectedBucketOwner: m.binding.accountId,
        })
      ).TagSet;
    case "ecr":
      return (await aws("ecr", "list-tags-for-resource", { resourceArn: arn }))
        .tags;
    default:
      throw new Error("UNKNOWN: unsupported native tag resource");
  }
}
async function collectRehearsalTags(aws, m) {
  if (m.kind !== "rehearsal-introduction") return [];
  const observations = [];
  for (const expected of m.resourceEvidence) {
    let tags;
    try {
      tags = await nativeTags(aws, m, expected.arn);
    } catch {
      throw new Error(
        "UNKNOWN: native rehearsal tag read prerequisite unavailable",
      );
    }
    assert.ok(Array.isArray(tags));
    const pairs = tags.map((t) => [t.Key ?? t.key, t.Value ?? t.value]);
    assert.equal(new Set(pairs.map((p) => p[0])).size, pairs.length);
    assert.deepEqual(
      Object.fromEntries(pairs),
      expected.tags,
      "UNKNOWN: native rehearsal ownership mismatch",
    );
    observations.push({ arn: expected.arn, tags });
  }
  return observations;
}
module.exports = { collectRehearsalTags };
