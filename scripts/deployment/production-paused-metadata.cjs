"use strict";
function pausedQueryInput(scope, id, kind, cursor) {
  const parent = kind === "parent",
    base = require("./paused-draft-contract.cjs");
  const fields = (parent ? base.parentFields : base.segmentFields).filter(
    (field) => !["sourceManifest", "label", "originalFileName"].includes(field),
  );
  const names = Object.fromEntries(fields.map((field) => [`#${field}`, field]));
  const values = { ":uploadId": { S: id.uploadId } },
    projection = fields.map((field) => `#${field}`);
  if (parent) {
    names["#manifest"] = "sourceManifest";
    for (const field of [
      "sourceId",
      "kind",
      "sourceS3Key",
      "contentType",
      "fileSize",
    ]) {
      names[`#${field}`] = field;
      for (let i = 0; i < id.sourceCount; i++)
        projection.push(`#manifest[${i}].#${field}`);
    }
    values[":listType"] = { S: "L" };
    values[":sourceCount"] = { N: String(id.sourceCount) };
  }
  return {
    TableName: parent ? scope.personalJobTable : scope.personalSegmentTable,
    ConsistentRead: true,
    KeyConditionExpression: "#uploadId = :uploadId",
    ProjectionExpression: projection.join(","),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(parent
      ? {
          FilterExpression:
            "attribute_type(#manifest, :listType) AND size(#manifest) = :sourceCount",
        }
      : {}),
    ...(cursor ? { ExclusiveStartKey: cursor } : {}),
  };
}
module.exports = { pausedQueryInput };
