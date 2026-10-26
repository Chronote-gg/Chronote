"use strict";
const assert = require("node:assert/strict");
function validateBinding(binding) {
  assert.ok(binding);
  const {
    accountId,
    region,
    taskRoleArn,
    activeMeetingTableArn,
    personalMediaUploadJobTableArn,
    operationId,
  } = binding;
  assert.match(accountId, /^\d{12}$/);
  assert.match(region, /^[a-z]{2}(?:-[a-z]+)+-\d$/);
  assert.match(
    operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.match(
    taskRoleArn,
    new RegExp(
      "^arn:aws:iam::" +
        accountId +
        ":role/(?:[A-Za-z0-9_+=,.@-]+/)*[A-Za-z0-9_+=,.@-]+$",
    ),
  );
  const prefix = "arn:aws:dynamodb:" + region + ":" + accountId + ":table/";
  for (const [arn, suffix] of [
    [activeMeetingTableArn, "ActiveMeetingTable"],
    [personalMediaUploadJobTableArn, "PersonalMediaUploadJobTable"],
  ]) {
    assert.ok(arn && arn.startsWith(prefix));
    assert.match(
      arn.slice(prefix.length),
      new RegExp("^[A-Za-z0-9_.-]*" + suffix + "$"),
    );
  }
}
function buildMaintenancePolicy(binding) {
  validateBinding(binding);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "FenceMeetingAcquisition",
        Effect: "Deny",
        Action: "dynamodb:PutItem",
        Resource: binding.activeMeetingTableArn,
      },
      {
        Sid: "FenceUploadClaim",
        Effect: "Deny",
        Action: "dynamodb:UpdateItem",
        Resource: binding.personalMediaUploadJobTableArn,
        Condition: {
          "ForAnyValue:StringEquals": {
            "dynamodb:Attributes": "processingStartedAt",
          },
        },
      },
    ],
  };
}
module.exports = { buildMaintenancePolicy, validateBinding };
