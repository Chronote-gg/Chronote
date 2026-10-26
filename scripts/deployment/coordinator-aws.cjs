"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

class CoordinatorFailure extends Error {
  constructor(category, message, operation) {
    super(message);
    this.category = category;
    this.operation = operation;
  }
}

async function awsCli(service, operation, input) {
  const validating = operation === "validate-update-service";
  const { stdout } = await exec(
    "aws",
    [
      service,
      validating ? "update-service" : operation,
      "--cli-input-json",
      JSON.stringify(input),
      ...(validating ? ["--generate-cli-skeleton", "input"] : []),
      "--output",
      "json",
      "--no-cli-pager",
    ],
    {
      maxBuffer: 4 * 1024 * 1024,
      // A hidden retry can outlive this call and invalidate the submitted fence.
      ...(service === "elbv2" && operation === "modify-listener"
        ? { env: { ...process.env, AWS_MAX_ATTEMPTS: "1" } }
        : {}),
    },
  );
  const response = stdout.trim() ? JSON.parse(stdout) : {};
  if (validating) {
    // Output skeletons can fail on invalid dummy responses in supported CLI models.
    const criteria = response.deploymentConfiguration?.earlySuccessCriteria;
    if (
      !criteria ||
      !["enable", "healthyPercent", "sourceServiceRevisionCleanup"].every(
        (field) => Object.hasOwn(criteria, field),
      )
    )
      throw new Error(
        "AWS CLI lacks deferred service revision cleanup support",
      );
  }
  return response;
}
function createAwsCaller(executeAws, diagnostic) {
  return async function callAws(service, operation, input) {
    const name = `${service}.${operation}`;
    diagnostic.operation = name;
    try {
      return await executeAws(service, operation, input);
    } catch {
      const categories = {
        "ecs.validate-update-service": "cli_capability_unsupported",
        "ecs.get-task-protection": "native_protection_unconfirmed",
      };
      const category =
        categories[name] ??
        (service === "dynamodb"
          ? "control_store_operation_failed"
          : "provider_operation_failed");
      throw new CoordinatorFailure(
        category,
        "Coordinator AWS operation failed",
        name,
      );
    }
  };
}
module.exports = { CoordinatorFailure, awsCli, createAwsCaller };
