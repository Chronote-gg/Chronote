"use strict";
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { z } = require("zod");
const { executeChild } = require("./owned-child.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sandbox = z.string().regex(/^[a-z0-9-]*sandbox[a-z0-9-]*$/);
const schema = z
  .object({
    environment: z.literal("sandbox"),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    principalArn: z
      .string()
      .regex(/^arn:aws:(iam::\d{12}:user\/|sts:[^:]*:\d{12}:assumed-role\/).+/),
    operationId: z.string().uuid(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    tablePrefix: sandbox.refine((v) => v.endsWith("-")),
    bucket: sandbox,
    cluster: sandbox,
    service: sandbox,
    containerName: sandbox,
    legacyTaskDefinition: z.string(),
    taskDefinition: z.string(),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runtimeMode: z.enum(["all", "bot", "api"]),
    containerPort: z.number().int().positive().max(65535),
    listenerArn: z.string(),
    targetGroupA: z.string(),
    targetGroupB: z.string(),
    maintenance: z
      .object({
        testOnly: z.literal(true),
        workSettled: z.literal(true),
        receiptSha256: hash,
        confirmedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
function manifestHash(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function parseManifest(input, expectedSha256) {
  if (
    !hash.safeParse(expectedSha256).success ||
    manifestHash(input) !== expectedSha256
  )
    throw new Error("Manifest checksum mismatch");
  const m = schema.parse(input);
  const ecs = `arn:aws:ecs:${m.region}:${m.accountId}:task-definition/`;
  const elb = `arn:aws:elasticloadbalancing:${m.region}:${m.accountId}:`;
  if (
    !m.principalArn.includes(`:${m.accountId}:`) ||
    ![m.taskDefinition, m.legacyTaskDefinition].every(
      (v) =>
        v.startsWith(ecs) &&
        /^[a-z0-9-]*sandbox[a-z0-9-]*:\d+$/.test(v.slice(ecs.length)),
    ) ||
    m.taskDefinition === m.legacyTaskDefinition ||
    !m.listenerArn.startsWith(elb + "listener/app/") ||
    ![m.targetGroupA, m.targetGroupB].every(
      (v) =>
        v.startsWith(elb + "targetgroup/") &&
        v.slice(elb.length).includes("sandbox"),
    ) ||
    m.targetGroupA === m.targetGroupB
  )
    throw new Error("Manifest resource binding mismatch");
  return m;
}
function awsCaller(region) {
  if (
    Object.keys(process.env).some(
      (k) => k.startsWith("AWS_ENDPOINT_URL") && process.env[k],
    )
  )
    throw new Error("Custom AWS endpoints are not supported");
  return async (service, operation, input, { signal } = {}) => {
    const { stdout } = await executeChild(
      "aws",
      [
        service,
        operation,
        "--region",
        region,
        "--cli-input-json",
        JSON.stringify(input),
        "--output",
        "json",
        "--no-cli-pager",
        "--no-paginate",
      ],
      {
        maxBuffer: 8 * 1024 * 1024,
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: {
          ...process.env,
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
          AWS_MAX_ATTEMPTS: "1",
          AWS_RETRY_MODE: "standard",
        },
      },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  };
}
function readArguments(args) {
  if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--sha256")
    throw new Error("Expected --manifest FILE --sha256 HASH");
  const input = JSON.parse(
    readFileSync(args[1], "utf8").replace(/^\uFEFF/, ""),
  );
  return { manifest: input, expectedSha256: args[3] };
}
module.exports = { parseManifest, manifestHash, awsCaller, readArguments };
