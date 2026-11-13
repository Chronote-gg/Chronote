"use strict";
const { execFile } = require("node:child_process");
const { isDeepStrictEqual, promisify } = require("node:util");
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
const REGISTRY_READ_ATTEMPTS = 3;
const REGISTRY_RETRY_MS = 5 * SECOND_MS;
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

  async function olderTasks() {
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

  /**
   * An older task is draining only on positive evidence: a ready worker runs
   * a higher release than the task's revision. Draining is sticky, so one
   * stale sample of the newer worker cannot end a real drain. A task whose
   * own record is ready with nothing newer ready is the serving worker (the
   * worker's own eligibility rule) and is neither waited for nor retired; it
   * too leaves that state only when superseded. Any other task is unknown:
   * it is waited for but never retired, and is re-evaluated every poll, so a
   * serving worker whose first sample was stale is recognised once fresh.
   */
  async function drainingTasks(wait) {
    const older = await olderTasks();
    const open = older.filter((task) => !wait.draining.has(task.taskArn));
    const ready = open.length ? await readyForDrain(wait.retire) : [];
    if (ready) for (const task of open) classify(task, ready, wait);
    const latched = (task) => wait.draining.has(task.taskArn);
    return {
      waiting: ready
        ? older.filter((task) => !wait.serving.has(task.taskArn))
        : older,
      draining: older.filter(latched),
    };
  }

  function classify(task, ready, wait) {
    const revision = Number(task.taskDefinitionArn.split(":").pop());
    if (ready.some((record) => record.release > revision)) {
      wait.serving.delete(task.taskArn);
      wait.draining.add(task.taskArn);
    } else if (
      !wait.serving.has(task.taskArn) &&
      ready.some((record) => record.taskArn === task.taskArn)
    ) {
      log(
        `Older task ${task.taskArn} is the serving worker on revision ${revision} and no newer revision has a ready worker; not waited for`,
      );
      wait.serving.add(task.taskArn);
    }
  }

  /**
   * A drain can run for hours, so without retire an unreadable registry only
   * makes this poll count every older task as draining. With retire it fails
   * the step, because guessing could stop the serving worker.
   */
  async function readyForDrain(retire) {
    try {
      return await readyWorkers();
    } catch (error) {
      if (retire) throw error;
      log(
        "Worker registry could not be read; every older task counts as draining for this poll",
      );
      return null;
    }
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

  /** One failed read must not fail a step, so every registry read gets three tries. */
  async function registryWithRetry(label) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await registry();
      } catch (error) {
        log(
          `${label} ${attempt} of ${REGISTRY_READ_ATTEMPTS} failed: ${error.message}`,
        );
        if (attempt === REGISTRY_READ_ATTEMPTS) throw error;
        await sleep(REGISTRY_RETRY_MS);
      }
    }
  }

  async function workers() {
    const nowSeconds = Math.floor(now() / SECOND_MS);
    return (await registryWithRetry("Worker registry read")).filter(
      (record) =>
        String(record.sk).startsWith(WORKER_SK_PREFIX) &&
        record.heartbeatAt >= nowSeconds - HEARTBEAT_FRESH_SECONDS,
    );
  }

  async function readyWorkers() {
    return (await workers()).filter((record) => record.ready === true);
  }

  async function cutoverState() {
    try {
      const marked = (await registryWithRetry("Cutover marker read")).some(
        (record) => record.sk === CUTOVER_SK,
      );
      return marked ? CUTOVER.present : CUTOVER.absent;
    } catch {
      return CUTOVER.unknown;
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
    const wait = { retire, serving: new Set(), draining: new Set() };
    for (;;) {
      const { waiting, draining } = await drainingTasks(wait);
      const unknown = waiting.length - draining.length;
      log(
        `${waiting.length} older ${waiting.length === 1 ? "task" : "tasks"} waited for (${draining.length} draining, ${unknown} unknown)`,
      );
      if (!waiting.length) break;
      if (now() - started >= DRAIN_TIMEOUT_MS) {
        await aws("cloudwatch", "put-metric-data", {
          Namespace: namespace,
          MetricData: [{ MetricName: DRAIN_METRIC, Value: 1, Unit: "Count" }],
        });
        throw new Error(drainTimeoutMessage(unknown));
      }
      if (retire) await retireTasks(draining, retired);
      await sleep(DRAIN_POLL_MS);
    }
  }

  function drainTimeoutMessage(unknown) {
    const message = `Older tasks still running after ${DRAIN_TIMEOUT_MS / MINUTE_MS} minutes`;
    if (!unknown) return message;
    return `${message}; ${unknown} of them never showed a fresh ready worker record and no newer revision became ready, so none was stopped. Check whether a worker on the new revision ever reported ready, and whether each older task's worker is writing its registry heartbeat`;
  }

  /** Stops each draining task once; `retired` remembers stops across polls. */
  async function retireTasks(draining, retired) {
    for (const task of draining) {
      if (retired.has(task.taskArn)) continue;
      await aws("ecs", "stop-task", {
        cluster: cluster(),
        task: task.taskArn,
        reason: RETIRE_REASON,
      });
      retired.add(task.taskArn);
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

  function registrationInput(definition, image) {
    const input = structuredClone(definition);
    for (const field of READ_ONLY_TASK_FIELDS) delete input[field];
    for (const container of input.containerDefinitions)
      if (container.environment)
        container.environment = container.environment.filter(
          (entry) => entry.name !== CANDIDATE_ENV,
        );
    applicationContainer(input).image = image;
    return input;
  }

  /**
   * A copy for comparison only: ECS may return name-keyed lists such as
   * `environment` and `secrets` in another order than they were registered.
   */
  function sortedByName(value) {
    if (Array.isArray(value)) {
      const items = value.map(sortedByName);
      return items.every((item) => typeof item?.name === "string")
        ? items.sort((a, b) => a.name.localeCompare(b.name))
        : items;
    }
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, sortedByName(item)]),
      );
    return value;
  }

  /**
   * Registers `template` with `image` and points the service at it. Without a
   * template the family name resolves to the latest ACTIVE revision, which is
   * how a Terraform-registered environment change reaches the service.
   */
  async function deployImage(image, { template, rolloutState = {} } = {}) {
    const family = required("ECS_TASK_FAMILY");
    const svc = await service();
    const previousImage = await servingImage(svc);
    const base = template ?? (await taskDefinition(family));
    if (base.family !== family) throw new Error("Task family mismatch");
    const registered = (
      await aws(
        "ecs",
        "register-task-definition",
        registrationInput(base, image),
      )
    ).taskDefinition;
    // Printed first so a run that fails from here on still knows what to roll back to.
    output({
      previousImage,
      previousTaskDefinition: svc.taskDefinition,
      ...rolloutState,
    });
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
    // Read before the update: a marker written later, while the new worker
    // comes up, must not let rollback pick the old runtime's image.
    return deployImage(image, {
      rolloutState: { cutover: await cutoverState() },
    });
  }

  async function waitReady({ release }) {
    if (!Number.isInteger(release) || release < 1)
      throw new Error("--release must be a task definition revision");
    const started = now();
    for (;;) {
      const ready = (await readyWorkers()).some(
        (record) => record.release === release,
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

  /**
   * Rollback swaps only the image back. It never restores an earlier task
   * definition, because the next deployment starts from the family's latest
   * revision and would silently drop a Terraform change. So a failure the
   * task definition may have caused is left for a forward repair.
   */
  function assertImageOnlyChange(failed, previous) {
    const sameImage =
      applicationContainer(failed).image ===
      applicationContainer(previous).image;
    const sameDefinition = isDeepStrictEqual(
      sortedByName(registrationInput(failed, "")),
      sortedByName(registrationInput(previous, "")),
    );
    if (!sameImage && sameDefinition) return;
    if (sameImage && sameDefinition)
      throw new Error(
        `Cutover marker present: revision ${failed.revision} runs the same image and configuration as revision ${previous.revision}, so there is nothing to roll back to. Nothing was rolled back. The failure needs a forward repair: fix the cause and deploy again; failing the run`,
      );
    const difference = sameImage
      ? "runs the same image as"
      : "differs in more than its image from";
    throw new Error(
      `Cutover marker present: the failure is in the task definition, which rolling back the image cannot repair: revision ${failed.revision} ${difference} revision ${previous.revision}. Nothing was rolled back. Repair forward: fix the configuration and deploy again; failing the run`,
    );
  }

  async function rollback({ image, previousTaskDefinition, rolloutCutover }) {
    if (!image) throw new Error("--image is required");
    if (!previousTaskDefinition)
      throw new Error("--previous-task-definition is required");
    // Release numbers only ever increase, so the only rollback is a higher
    // revision, and it is only correct once new workers are in charge. The
    // state recorded at rollout decides: when the marker appeared later, the
    // previous image is the old runtime's, which cannot start any more.
    if (rolloutCutover === CUTOVER.absent)
      throw new Error(
        "Cutover marker absent: the old runtime is still in charge. Nothing was rolled back: the service still points at the revision that failed and the old runtime's task was not touched. Fix forward with a new deployment of a fixed commit, never a rollback, and do not stop the old task until a new worker reports ready; failing the run",
      );
    if (rolloutCutover !== CUTOVER.present)
      throw new Error(
        "Cutover marker unreadable: the cutover state could not be read, so nothing was changed. If the cutover has already happened, roll back by redeploying the last good commit; failing the run",
      );
    // A rollout that ECS rejected left the service where it was; replacing the
    // serving tasks with the same image would only start a needless drain.
    const failedArn = (await service()).taskDefinition;
    if (failedArn === previousTaskDefinition)
      throw new Error(
        "Cutover marker present: the service never moved off the previous revision; nothing rolled back, failing the run",
      );
    const failed = await taskDefinition(failedArn);
    assertImageOnlyChange(failed, await taskDefinition(previousTaskDefinition));
    // Registered from the revision just compared, so a revision Terraform
    // registered since then cannot slip in uncompared.
    const { revision } = await deployImage(image, { template: failed });
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
    else if (flag === "--previous-task-definition")
      options.previousTaskDefinition = rest[++index];
    else if (flag === "--rollout-cutover")
      options.rolloutCutover = rest[++index];
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
