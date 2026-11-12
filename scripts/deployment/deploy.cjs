"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DRAIN_TIMEOUT_MS = 160 * MINUTE_MS;
const DRAIN_POLL_MS = 30 * SECOND_MS;
const PROTECTION_WAIT_MS = 5 * MINUTE_MS;
const READY_TIMEOUT_MS = 15 * MINUTE_MS;
const REGISTRY_POLL_MS = 10 * SECOND_MS;
const HEARTBEAT_FRESH_SECONDS = 30;
const HEALTH_CHECK_GRACE_PERIOD_SECONDS = 300;
// The breaker stays off so ECS never moves the service to a lower revision by itself.
const DEPLOYMENT_SETTINGS = {
  deploymentCircuitBreaker: { enable: false, rollback: false },
  minimumHealthyPercent: 100,
  maximumPercent: 200,
  earlySuccessCriteria: {
    enable: true,
    healthyPercent: 100,
    sourceServiceRevisionCleanup: "DEFERRED",
  },
};
const AWS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const WORKERS_PK = "WORKERS";
const WORKER_SK_PREFIX = "WORKER#";
const CUTOVER_SK = "CUTOVER";
const MARKER_READ_ATTEMPTS = 3;
const MARKER_RETRY_MS = 5 * SECOND_MS;
const CUTOVER = { present: "present", absent: "absent", unknown: "unknown" };
const DRAIN_METRIC = "DrainWaitTimedOut";
const RETIRE_REASON = "Retired by a deployment";
const CANDIDATE_ENV = "DEPLOYMENT_CANDIDATE_ID";
const TABLE_PREFIX_ENV = "DDB_TABLE_PREFIX";
const READ_ONLY_TASK_FIELDS = [
  "taskDefinitionArn",
  "revision",
  "status",
  "requiresAttributes",
  "compatibilities",
  "registeredAt",
  "registeredBy",
  "deregisteredAt",
];
const DIGEST_IMAGE = /@sha256:[a-f0-9]{64}$/;

const exec = promisify(execFile);

async function awsCli(service, operation, params) {
  try {
    // The CLI paginates list-tasks and query itself, so callers see every page.
    const { stdout } = await exec(
      "aws",
      [
        service,
        operation,
        "--cli-input-json",
        JSON.stringify(params),
        "--output",
        "json",
        "--no-cli-pager",
      ],
      { maxBuffer: AWS_OUTPUT_LIMIT_BYTES },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    // The default message repeats the command line, which carries the task definition.
    const detail = String(error.stderr ?? "")
      .trim()
      .split("\n")[0];
    // eslint-disable-next-line preserve-caught-error -- the cause carries that command line
    throw new Error(`aws ${service} ${operation} failed: ${detail}`);
  }
}

function createDeploy({ aws, env, now, sleep, log, output }) {
  function required(key) {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  const cluster = () => required("ECS_CLUSTER");
  const serviceName = () => required("ECS_SERVICE");

  async function service() {
    const { services } = await aws("ecs", "describe-services", {
      cluster: cluster(),
      services: [serviceName()],
    });
    const found = services?.[0];
    if (!found) throw new Error(`Service ${serviceName()} not found`);
    if (found.status !== "ACTIVE")
      throw new Error(`Service ${serviceName()} is ${found.status}`);
    return found;
  }

  async function preflight() {
    const svc = await service();
    const bound = (svc.loadBalancers ?? [])
      .map((binding) => binding.targetGroupArn)
      .filter(Boolean);
    if (!bound.length) return;
    const { Listeners } = await aws("elbv2", "describe-listeners", {
      ListenerArns: [required("DEPLOYMENT_LISTENER_ARN")],
    });
    const forwards = (Listeners?.[0]?.DefaultActions ?? []).filter(
      (action) => action.Type === "forward",
    );
    const groups =
      forwards[0]?.ForwardConfig?.TargetGroups ??
      (forwards[0]?.TargetGroupArn
        ? [{ TargetGroupArn: forwards[0].TargetGroupArn, Weight: 1 }]
        : []);
    const weighted = groups.filter((group) => group.Weight > 0);
    if (
      forwards.length !== 1 ||
      weighted.length !== 1 ||
      !bound.includes(weighted[0].TargetGroupArn)
    )
      throw new Error(
        "Listener does not send full weight to the target group the service is bound to",
      );
  }

  async function drainingTasks() {
    const svc = await service();
    const { taskArns } = await aws("ecs", "list-tasks", {
      cluster: cluster(),
      serviceName: serviceName(),
      desiredStatus: "RUNNING",
    });
    if (!taskArns?.length) return [];
    // ponytail: one describe-tasks call caps at 100 tasks, far above this service's count.
    const { tasks } = await aws("ecs", "describe-tasks", {
      cluster: cluster(),
      tasks: taskArns,
    });
    return tasks.filter(
      (task) =>
        task.lastStatus !== "STOPPED" &&
        task.taskDefinitionArn !== svc.taskDefinition,
    );
  }

  async function registry() {
    const { Items } = await aws("dynamodb", "query", {
      TableName: required("DEPLOYMENT_CONTROL_TABLE"),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: WORKERS_PK } },
      ConsistentRead: true,
    });
    return (Items ?? []).map((item) => unmarshall(item));
  }

  async function workers() {
    const nowSeconds = Math.floor(now() / SECOND_MS);
    return (await registry()).filter(
      (record) =>
        String(record.sk).startsWith(WORKER_SK_PREFIX) &&
        record.heartbeatAt >= nowSeconds - HEARTBEAT_FRESH_SECONDS,
    );
  }

  async function cutoverState() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const marked = (await registry()).some(
          (record) => record.sk === CUTOVER_SK,
        );
        return marked ? CUTOVER.present : CUTOVER.absent;
      } catch (error) {
        log(
          `Cutover marker read ${attempt} of ${MARKER_READ_ATTEMPTS} failed: ${error.message}`,
        );
        if (attempt === MARKER_READ_ATTEMPTS) return CUTOVER.unknown;
        await sleep(MARKER_RETRY_MS);
      }
    }
  }

  async function waitForProtection() {
    const started = now();
    for (;;) {
      const nowSeconds = Math.floor(now() / SECOND_MS);
      const unprotected = (await workers()).filter(
        (record) =>
          record.captures > 0 && !(record.protectedUntil > nowSeconds),
      );
      if (!unprotected.length) return;
      if (now() - started >= PROTECTION_WAIT_MS) {
        log(
          `${unprotected.length} capturing workers did not report protection; proceeding`,
        );
        return;
      }
      await sleep(REGISTRY_POLL_MS);
    }
  }

  async function waitDrain({ retire = false } = {}) {
    const cutover = await cutoverState();
    if (cutover === CUTOVER.absent) {
      // Before the cutover the only older task is the old runtime, which the
      // first-deployment procedure stops by hand once a new worker is ready.
      if (retire)
        log(
          "Cutover marker absent: retire is not available before the cutover",
        );
      log(
        "Cutover marker absent: the old runtime is still in charge and is not waited for",
      );
    } else {
      // Before the cutover the older task is the only serving worker.
      if (cutover === CUTOVER.unknown && retire)
        throw new Error(
          "Cutover marker unreadable: the cutover state could not be read, so retiring older tasks was refused and nothing was stopped",
        );
      if (cutover === CUTOVER.unknown)
        log(
          "Cutover marker could not be read; waiting for older tasks as after the cutover",
        );
      await waitForOlderTasks(retire);
    }
    await waitForProtection();
  }

  async function waitForOlderTasks(retire) {
    const namespace = `${required("SECRETS_PREFIX")}/Deploy`;
    const started = now();
    const retired = new Set();
    for (;;) {
      const draining = await drainingTasks();
      log(
        `${draining.length} older ${draining.length === 1 ? "task" : "tasks"} draining`,
      );
      if (!draining.length) break;
      if (now() - started >= DRAIN_TIMEOUT_MS) {
        await aws("cloudwatch", "put-metric-data", {
          Namespace: namespace,
          MetricData: [{ MetricName: DRAIN_METRIC, Value: 1, Unit: "Count" }],
        });
        throw new Error(
          `Older tasks still running after ${DRAIN_TIMEOUT_MS / MINUTE_MS} minutes`,
        );
      }
      if (retire)
        for (const task of draining) {
          if (retired.has(task.taskArn)) continue;
          await aws("ecs", "stop-task", {
            cluster: cluster(),
            task: task.taskArn,
            reason: RETIRE_REASON,
          });
          retired.add(task.taskArn);
        }
      await sleep(DRAIN_POLL_MS);
    }
  }

  async function taskDefinition(reference) {
    return (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: reference,
      })
    ).taskDefinition;
  }

  function applicationContainer(definition) {
    const tablePrefix = `${required("SECRETS_PREFIX")}-`;
    const matches = definition.containerDefinitions.filter((container) =>
      container.environment?.some((entry) => entry.name === TABLE_PREFIX_ENV),
    );
    if (matches.length !== 1)
      throw new Error(
        `Expected one application container with ${TABLE_PREFIX_ENV}`,
      );
    const route = matches[0].environment.find(
      (entry) => entry.name === TABLE_PREFIX_ENV,
    );
    if (route.value !== tablePrefix)
      throw new Error(`Application container ${TABLE_PREFIX_ENV} mismatch`);
    return matches[0];
  }

  async function servingImage(svc) {
    return applicationContainer(await taskDefinition(svc.taskDefinition)).image;
  }

  async function deployImage(image) {
    const family = required("ECS_TASK_FAMILY");
    const svc = await service();
    const previousImage = await servingImage(svc);
    // The family name resolves to the latest ACTIVE revision, which is how a
    // Terraform-registered environment change reaches the service.
    const latest = await taskDefinition(family);
    if (latest.family !== family) throw new Error("Task family mismatch");
    const input = structuredClone(latest);
    for (const field of READ_ONLY_TASK_FIELDS) delete input[field];
    for (const container of input.containerDefinitions)
      if (container.environment)
        container.environment = container.environment.filter(
          (entry) => entry.name !== CANDIDATE_ENV,
        );
    applicationContainer(input).image = image;
    const registered = (await aws("ecs", "register-task-definition", input))
      .taskDefinition;
    // Printed first so a run that fails from here on still knows what to roll back to.
    output({ previousImage });
    try {
      await aws("ecs", "update-service", {
        cluster: cluster(),
        service: serviceName(),
        taskDefinition: registered.taskDefinitionArn,
        healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_PERIOD_SECONDS,
        deploymentConfiguration: {
          ...svc.deploymentConfiguration,
          ...DEPLOYMENT_SETTINGS,
        },
      });
    } catch (error) {
      // The call can fail after ECS has already accepted the update.
      const after = await service().catch(() => null);
      if (after?.taskDefinition !== registered.taskDefinitionArn) throw error;
      log(`${error.message}; the service is on the new revision anyway`);
    }
    log(`Service updated to revision ${registered.revision}`);
    return { revision: registered.revision, previousImage };
  }

  async function rollout({ image }) {
    if (!DIGEST_IMAGE.test(image ?? ""))
      throw new Error("--image must pin a sha256 digest");
    return deployImage(image);
  }

  async function waitReady({ release }) {
    if (!Number.isInteger(release) || release < 1)
      throw new Error("--release must be a task definition revision");
    const started = now();
    for (;;) {
      const ready = (await workers()).some(
        (record) => record.release === release && record.ready === true,
      );
      if (ready) {
        log(`A worker on revision ${release} is ready`);
        return;
      }
      if (now() - started >= READY_TIMEOUT_MS)
        throw new Error(
          `No ready worker on revision ${release} after ${READY_TIMEOUT_MS / MINUTE_MS} minutes`,
        );
      await sleep(REGISTRY_POLL_MS);
    }
  }

  async function rollback({ image }) {
    if (!image) throw new Error("--image is required");
    // Release numbers only ever increase, so the only rollback is a higher
    // revision, and it is only correct once new workers are in charge.
    const cutover = await cutoverState();
    if (cutover === CUTOVER.absent)
      throw new Error(
        "Cutover marker absent: the old runtime is still in charge. Nothing was rolled back: the service still points at the revision that failed and the old runtime's task was not touched. Fix forward with a new deployment of a fixed commit, never a rollback, and do not stop the old task until a new worker reports ready; failing the run",
      );
    if (cutover === CUTOVER.unknown)
      throw new Error(
        "Cutover marker unreadable: the cutover state could not be read, so nothing was changed. If the cutover has already happened, roll back by redeploying the last good commit; failing the run",
      );
    // A rollout that ECS rejected left the service where it was; replacing the
    // serving tasks with the same image would only start a needless drain.
    if ((await servingImage(await service())) === image)
      throw new Error(
        "Cutover marker present: the service never moved off the previous image; nothing rolled back, failing the run",
      );
    const { revision } = await deployImage(image);
    throw new Error(
      `Cutover marker present: rolled back to the previous image as revision ${revision}; failing the run`,
    );
  }

  return { preflight, waitDrain, rollout, waitReady, rollback };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--retire") options.retire = true;
    else if (flag === "--image") options.image = rest[++index];
    else if (flag === "--release") options.release = Number(rest[++index]);
    else throw new Error(`Unknown argument ${flag}`);
  }
  return { command, options };
}

const COMMANDS = {
  preflight: "preflight",
  "wait-drain": "waitDrain",
  rollout: "rollout",
  "wait-ready": "waitReady",
  rollback: "rollback",
};

function printJson(value) {
  console.log(JSON.stringify(value));
}

async function main(argv) {
  const { command, options } = parseArguments(argv);
  const method = COMMANDS[command];
  if (!method)
    throw new Error(`Usage: deploy.cjs <${Object.keys(COMMANDS).join("|")}>`);
  const deploy = createDeploy({
    aws: awsCli,
    env: process.env,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.error(line),
    output: printJson,
  });
  const result = await deploy[method](options);
  if (result !== undefined) printJson(result);
}

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { createDeploy, parseArguments };
