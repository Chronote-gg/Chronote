/** @jest-environment node */
import { execFile } from "node:child_process";
import { nativeTransport } from "../../scripts/deployment/collector-native.cjs";
import { collectRehearsalTags } from "../../scripts/deployment/collector-tags.cjs";
import { createProductionIntroduction } from "../../scripts/deployment/introduce-production.cjs";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";
import { awsCaller } from "../../scripts/deployment/sandbox-manifest.cjs";

// Run a generated CLI child, never the AWS executable or any provider endpoint.
jest.mock("node:child_process", () => {
  const actual =
    jest.requireActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const generatedCli = `
    if (process.argv.join(" ").includes("stall-owned-child")) setInterval(() => {}, 1000);
    else process.stdout.write(JSON.stringify({
      ignoreConfiguredEndpoints: process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,
      attempts: process.env.AWS_MAX_ATTEMPTS,
      retryMode: process.env.AWS_RETRY_MODE,
      region: process.argv[process.argv.indexOf("--region") + 1]
    }));`;
  return {
    execFile: jest.fn((file, args, options, callback) => {
      expect(file).toBe("aws");
      expect(args).not.toContain("--endpoint-url");
      expect(args).toContain("--no-paginate");
      return actual.execFile(
        process.execPath,
        ["-e", generatedCli, ...args],
        options,
        callback,
      );
    }),
  };
});

const previous = { ...process.env };
afterEach(() => {
  process.env = { ...previous };
});

test.each([undefined, "false"])(
  "shared-config endpoint overrides are disabled even when inherited setting is %s",
  async (inherited) => {
    if (inherited === undefined)
      delete process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS;
    else process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = inherited;
    process.env.AWS_MAX_ATTEMPTS = "9";
    process.env.AWS_RETRY_MODE = "adaptive";
    expect(
      await awsCaller("us-east-1")("sts", "get-caller-identity", {}),
    ).toEqual({
      ignoreConfiguredEndpoints: "true",
      attempts: "1",
      retryMode: "standard",
      region: "us-east-1",
    });
  },
);

test("explicit endpoint environment overrides still refuse before any child starts", () => {
  process.env.AWS_ENDPOINT_URL_ECS = "http://127.0.0.1:1";
  expect(() => awsCaller("us-east-1")).toThrow("Custom AWS endpoints");
});

test("production wrapper uses explicit-page single-attempt transport after its own validation", async () => {
  const manifest = manifestFixture();
  const execute = jest.mocked(execFile);
  execute.mockClear();
  await expect(
    createProductionIntroduction({
      manifest,
      expectedSha256: manifestHash(manifest),
    }).run("inspect"),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
  const [file, args, options] = execute.mock.calls[0];
  expect(file).toBe("aws");
  expect(args).toContain("--no-paginate");
  expect(options.env.AWS_MAX_ATTEMPTS).toBe("1");
  expect(options.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe("true");
  execute.mockClear();
  expect(() =>
    createProductionIntroduction({
      manifest: { ...manifest, environment: "sandbox" },
      expectedSha256: manifestHash(manifest),
    }),
  ).toThrow();
  expect(execute).not.toHaveBeenCalled();
});

test("stalled rehearsal tags cancel and reap only their owned CLI child before rejecting", async () => {
  const execute = jest.mocked(execFile);
  execute.mockClear();
  const native = nativeTransport(
    awsCaller("us-east-1"),
    Date.now() / 1000 + 0.2,
  );
  await expect(
    collectRehearsalTags(native, {
      kind: "rehearsal-introduction",
      resourceEvidence: [
        {
          arn: "arn:aws:ecs:us-east-1:123456789012:cluster/stall-owned-child",
          tags: {},
        },
      ],
    }),
  ).rejects.toThrow(/prerequisite/);
  expect(execute).toHaveBeenCalledTimes(1);
  const child = execute.mock.results[0].value;
  expect(child.killed).toBe(true);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(execute.mock.calls[0][2].signal?.aborted).toBe(true);
}, 2000);
