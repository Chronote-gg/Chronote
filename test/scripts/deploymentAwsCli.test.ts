/** @jest-environment node */
import { awsCli } from "../../scripts/deployment/coordinator.cjs";

// Exercise the real CLI adapter with a generated child process, never an AWS executable.
jest.mock("node:child_process", () => {
  const actual =
    jest.requireActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { promisify } =
    jest.requireActual<typeof import("node:util")>("node:util");
  const execute = promisify(actual.execFile);
  const generatedCli = `
    const input = JSON.parse(process.argv[process.argv.indexOf("--cli-input-json") + 1]);
    const skeleton = process.argv.indexOf("--generate-cli-skeleton");
    if (skeleton !== -1) {
      if (process.argv[skeleton + 1] !== "input") process.exit(24);
      const criteria = { enable: true, healthyPercent: 0, sourceServiceRevisionCleanup: "BLOCKING" };
      delete criteria[input.fixtureMissing];
      process.stdout.write(JSON.stringify({ deploymentConfiguration: {
        earlySuccessCriteria: input.fixtureMissing === "all" ? undefined : criteria
      } }));
      process.exit(0);
    }
    const attempts = Number(process.env.AWS_MAX_ATTEMPTS);
    if (input.fixtureUnknown && attempts === 1) process.exit(23);
    process.stdout.write(JSON.stringify({ attempts, mode: process.env.AWS_RETRY_MODE, operation: process.argv[2], hiddenRetry: Boolean(input.fixtureUnknown) }));
  `;
  const execFile = Object.assign(jest.fn(), {
    [promisify.custom]: (
      file: string,
      args: string[],
      options: import("node:child_process").ExecFileOptions,
    ) => {
      expect(file).toBe("aws");
      // Jest virtualizes process.env; emulate default child inheritance explicitly.
      return execute(process.execPath, ["-e", generatedCli, ...args], {
        ...options,
        env: options.env ?? process.env,
      });
    },
  });
  return { execFile };
});

test("capability probe uses the input model without generating a dummy service response", async () => {
  expect(await awsCli("ecs", "validate-update-service", {})).toMatchObject({
    deploymentConfiguration: {
      earlySuccessCriteria: {
        enable: true,
        healthyPercent: 0,
        sourceServiceRevisionCleanup: "BLOCKING",
      },
    },
  });
});

test.each(["all", "enable", "healthyPercent", "sourceServiceRevisionCleanup"])(
  "capability probe rejects a CLI model missing %s",
  async (fixtureMissing) => {
    await expect(
      awsCli("ecs", "validate-update-service", { fixtureMissing }),
    ).rejects.toThrow();
  },
);

let previousAttempts: string | undefined;
let previousMode: string | undefined;
beforeEach(() => {
  previousAttempts = process.env.AWS_MAX_ATTEMPTS;
  previousMode = process.env.AWS_RETRY_MODE;
});
afterEach(() => {
  if (previousAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
  else process.env.AWS_MAX_ATTEMPTS = previousAttempts;
  if (previousMode === undefined) delete process.env.AWS_RETRY_MODE;
  else process.env.AWS_RETRY_MODE = previousMode;
});

test.each(["standard", "legacy", "adaptive"])(
  "listener write overrides inherited %s retries at the child execution boundary",
  async (mode) => {
    process.env.AWS_MAX_ATTEMPTS = "9";
    process.env.AWS_RETRY_MODE = mode;
    expect(await awsCli("elbv2", "modify-listener", {})).toMatchObject({
      attempts: 1,
      operation: "modify-listener",
    });
    await expect(
      awsCli("elbv2", "modify-listener", { fixtureUnknown: true }),
    ).rejects.toThrow();
    expect(await awsCli("elbv2", "describe-listeners", {})).toMatchObject({
      attempts: 9,
      mode,
      operation: "describe-listeners",
    });
  },
);
