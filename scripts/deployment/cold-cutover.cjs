"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { setTimeout: pause } = require("node:timers/promises");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { z } = require("zod");
const { awsCaller, manifestHash } = require("./sandbox-manifest.cjs");
const { action, canonical } = require("./routing.cjs");
const {
  candidateDefinition,
  runtimeMode,
  taskContainer,
} = require("./task-definition.cjs");
const { listServiceTaskArns } = require("./service-task-inventory.cjs");
const { assertPreparedCandidate } = require("./bootstrap-core.cjs");

const WORKFLOW_PATH = ".github/workflows/production-cutover.yml";
const STOP_TIMEOUT_SECONDS = 900;
const READY_TIMEOUT_SECONDS = 900;
const FINANCIAL_FLAGS = [
  "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
  "STRIPE_RENEWAL_GRACE_ENABLED",
  "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
  "STRIPE_RENEWAL_REACTIVATION_ENABLED",
];
// Any row, or any status that is not known to be terminal, counts as in-flight work.
// Leases are read last so the recording check sits closest to the stop.
const WORK = [
  {
    table: "MeetingControlCommandTable",
    field: "queueStatus",
    active: (row, now) =>
      !["completed", "failed"].includes(row.queueStatus) &&
      !(row.expiresAt <= now),
  },
  {
    table: "PersonalMediaUploadJobTable",
    field: "status",
    active: (row) => !["complete", "failed"].includes(row.status),
  },
  {
    table: "PersonalRecordingSegmentTable",
    field: "status",
    active: (row) => !["processed", "failed"].includes(row.status),
  },
  { table: "ActiveMeetingTable", field: "guildId", active: () => true },
];

class Refusal extends Error {}
function fail(message) {
  throw new Refusal(message);
}

const resourceName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const targetGroup = z.string().startsWith("arn:aws:elasticloadbalancing:");
const configSchema = z
  .object({
    environment: z.enum(["production", "sandbox"]),
    operationId: z.string().uuid().optional(),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/),
    sessionName: z.string().regex(/^chronote-(production|sandbox)-\d+-1$/),
    cluster: resourceName,
    service: resourceName,
    family: resourceName,
    tablePrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*-$/),
    listenerArn: z.string().startsWith("arn:aws:elasticloadbalancing:"),
    groups: z.tuple([targetGroup, targetGroup]),
    image: z
      .string()
      .regex(
        /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[\w./-]+@sha256:[a-f0-9]{64}$/,
      )
      .optional(),
  })
  .strict();

/** Reads and cross-checks workflow inputs so one environment's names can never drive the other. */
function cutoverConfig(env, mode) {
  const config = configSchema.parse({
    environment: env.CUTOVER_ENVIRONMENT,
    operationId: env.CUTOVER_OPERATION_ID || undefined,
    accountId: env.EXPECTED_ACCOUNT_ID,
    region: env.AWS_REGION,
    roleArn: env.EXPECTED_ROLE_ARN,
    sessionName: env.EXPECTED_SESSION_NAME,
    cluster: env.ECS_CLUSTER,
    service: env.ECS_SERVICE,
    family: env.ECS_TASK_FAMILY,
    tablePrefix: env.SECRETS_PREFIX + "-",
    listenerArn: env.DEPLOYMENT_LISTENER_ARN,
    groups: [env.DEPLOYMENT_TARGET_GROUP_A, env.DEPLOYMENT_TARGET_GROUP_B],
    image: env.CANDIDATE_IMAGE || undefined,
  });
  const sandbox = config.environment === "sandbox";
  const names = [
    config.cluster,
    config.service,
    config.family,
    config.tablePrefix,
    config.roleArn.split("/").at(-1),
  ];
  if (
    !names.every((v) => v.includes("sandbox") === sandbox) ||
    !config.roleArn.endsWith("-github-deploy") ||
    !config.roleArn.includes(`::${config.accountId}:`) ||
    !config.sessionName.startsWith(`chronote-${config.environment}-`) ||
    config.groups[0] === config.groups[1]
  )
    fail("Cutover configuration does not match its environment");
  if (
    mode === "cutover" &&
    (!config.operationId ||
      !config.image?.startsWith(
        `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/`,
      ))
  )
    fail("Cutover requires an operation id and a pinned candidate image");
  return config;
}

/** AWS's pre-introduction single forward to the service group, with or without a one-group ForwardConfig. */
function isLegacyForward(actions, sourceGroup) {
  const forward = actions?.[0];
  if (
    actions?.length !== 1 ||
    forward.Type !== "forward" ||
    forward.TargetGroupArn !== sourceGroup ||
    Object.keys(forward).some(
      (k) => !["Type", "Order", "TargetGroupArn", "ForwardConfig"].includes(k),
    )
  )
    return false;
  const config = forward.ForwardConfig;
  return (
    config === undefined ||
    (same(config.TargetGroups, [{ TargetGroupArn: sourceGroup, Weight: 1 }]) &&
      config.TargetGroupStickinessConfig?.Enabled === false)
  );
}

function createCutover({
  config,
  aws,
  now = () => Math.floor(Date.now() / 1000),
  sleep = () => pause(5000),
  log = () => {},
  bootstrapFactory = (options) =>
    require("./bootstrap-sandbox.cjs").createBootstrap(options),
}) {
  const table = config.tablePrefix + "DeploymentControlTable";
  const principalArn = `arn:aws:sts::${config.accountId}:assumed-role/${config.roleArn.split("/").at(-1)}/${config.sessionName}`;

  async function identity() {
    const caller = await aws("sts", "get-caller-identity", {});
    if (caller.Account !== config.accountId || caller.Arn !== principalArn)
      fail("Execution identity mismatch");
  }
  async function service() {
    const r = await aws("ecs", "describe-services", {
      cluster: config.cluster,
      services: [config.service],
    });
    const svc = r.services?.[0];
    if (
      r.failures?.length ||
      r.services?.length !== 1 ||
      svc.serviceName !== config.service ||
      svc.loadBalancers?.length !== 1 ||
      !config.groups.includes(svc.loadBalancers[0].targetGroupArn)
    )
      fail("Service identity or routing binding mismatch");
    return svc;
  }
  async function scan(TableName, fields, extra = {}) {
    const rows = [];
    let ExclusiveStartKey;
    do {
      const page = await aws("dynamodb", "scan", {
        TableName,
        ConsistentRead: true,
        ...(fields.length
          ? {
              ProjectionExpression: fields.map((_, i) => `#f${i}`).join(","),
              ExpressionAttributeNames: Object.fromEntries(
                fields.map((v, i) => [`#f${i}`, v]),
              ),
            }
          : {}),
        ...extra,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      rows.push(...(page.Items ?? []).map(unmarshall));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
  }
  async function countRows(TableName) {
    let total = 0,
      ExclusiveStartKey;
    do {
      const page = await aws("dynamodb", "scan", {
        TableName,
        ConsistentRead: true,
        Select: "COUNT",
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      total += page.Count;
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  }
  /** Counts in-flight work; a scan failure propagates so an unknown answer never reads as empty. */
  async function activeWork() {
    // A meeting can start and finish inside the stop window; history growth exposes it.
    const counts = {
      meetingHistoryRows: await countRows(
        config.tablePrefix + "MeetingHistoryTable",
      ),
    };
    for (const work of WORK) {
      const fields = [
        work.field,
        ...(work.field === "queueStatus" ? ["expiresAt"] : []),
      ];
      const rows = await scan(config.tablePrefix + work.table, fields);
      counts[work.table] = rows.filter((row) => work.active(row, now())).length;
    }
    const total = WORK.reduce((sum, w) => sum + counts[w.table], 0);
    return { counts, total };
  }
  async function read(sk) {
    const r = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: marshall({ pk: "ENV", sk }),
      ConsistentRead: true,
    });
    return r.Item ? unmarshall(r.Item) : undefined;
  }
  async function liveTasks() {
    const arns = await listServiceTaskArns(aws, config);
    const live = [];
    for (let i = 0; i < arns.length; i += 100) {
      const r = await aws("ecs", "describe-tasks", {
        cluster: config.cluster,
        tasks: arns.slice(i, i + 100),
      });
      if (r.failures?.length) fail("Task inventory incomplete");
      live.push(...r.tasks.filter((t) => t.lastStatus !== "STOPPED"));
    }
    return live;
  }
  async function targets(group) {
    return (
      await aws("elbv2", "describe-target-health", { TargetGroupArn: group })
    ).TargetHealthDescriptions;
  }
  function routingFor(svc) {
    const sourceGroup = svc.loadBalancers[0].targetGroupArn;
    return {
      sourceGroup,
      candidateGroup: config.groups.find((g) => g !== sourceGroup),
    };
  }
  /** "legacy" is the pre-introduction single forward to the service group; "weighted" is the coordinator form. */
  async function listenerForm(routing) {
    const r = await aws("elbv2", "describe-listeners", {
      ListenerArns: [config.listenerArn],
    });
    const listener = r.Listeners?.[0];
    if (r.Listeners?.length !== 1 || listener.Protocol !== "HTTPS")
      fail("Exact HTTPS listener unavailable");
    const rules = await aws("elbv2", "describe-rules", {
      ListenerArn: config.listenerArn,
    });
    if (
      rules.NextMarker ||
      rules.Rules?.length !== 1 ||
      !rules.Rules[0].IsDefault
    )
      fail("Listener has unreviewed routing rules");
    const actions = listener.DefaultActions;
    if (same(canonical(actions), canonical(action(routing, false))))
      return "weighted";
    if (isLegacyForward(actions, routing.sourceGroup)) return "legacy";
    return "foreign";
  }
  function revision(arn) {
    const match = /:task-definition\/([A-Za-z0-9-]+):(\d+)$/.exec(arn);
    if (match?.[1] !== config.family) fail("Task definition outside family");
    return Number(match[2]);
  }
  /** Candidates are registered after the service's current revision, so older revisions are skipped. */
  async function findCandidate(svc) {
    const floor = revision(svc.taskDefinition);
    const found = [];
    let nextToken;
    scanning: do {
      const page = await aws("ecs", "list-task-definitions", {
        familyPrefix: config.family,
        status: "ACTIVE",
        sort: "DESC",
        maxResults: 100,
        ...(nextToken ? { nextToken } : {}),
      });
      for (const arn of page.taskDefinitionArns) {
        if (revision(arn) < floor) break scanning;
        const d = (
          await aws("ecs", "describe-task-definition", { taskDefinition: arn })
        ).taskDefinition;
        if (
          d.containerDefinitions.some((c) =>
            c.environment?.some(
              (e) =>
                e.name === "DEPLOYMENT_CANDIDATE_ID" &&
                e.value === config.operationId,
            ),
          )
        )
          found.push(d);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    if (found.length > 1) fail("Ambiguous candidate task definitions");
    return found[0];
  }
  async function registerCandidate(svc) {
    const latest = (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: config.family,
      })
    ).taskDefinition;
    if (latest.family !== config.family)
      fail("Latest definition outside family");
    const next = candidateDefinition(latest, {
      image: config.image,
      candidateId: config.operationId,
      tablePrefix: config.tablePrefix,
    });
    const container = taskContainer(next, config.tablePrefix);
    if (
      runtimeMode(container) !== "all" ||
      container.name !== svc.loadBalancers[0].containerName
    )
      fail("Candidate container is not the single all-in-one runtime");
    container.command = ["node", "dist/index.js"];
    for (const flag of FINANCIAL_FLAGS) {
      const values = container.environment.filter((e) => e.name === flag);
      if (container.secrets?.some((s) => s.name === flag))
        fail("Financial flag supplied as a secret");
      if (!values.length)
        container.environment.push({ name: flag, value: "false" });
      else if (values.length !== 1 || values[0].value !== "false")
        fail("Financial flags must stay disabled for the cutover candidate");
    }
    log({ phase: "candidate_registration_submitted" });
    return (await aws("ecs", "register-task-definition", next)).taskDefinition;
  }
  /** The receipt hash covers only values that a resumed run can rederive from AWS. */
  function binding(svc, definition) {
    const container = taskContainer(definition, config.tablePrefix);
    const bucket = container.environment.filter(
      (e) => e.name === "TRANSCRIPTS_BUCKET",
    );
    const digest = container.image.split("@")[1];
    if (bucket.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
      fail("Candidate definition lacks a pinned image or bucket route");
    const lb = svc.loadBalancers[0];
    const routing = routingFor(svc);
    const stable = {
      environment: config.environment,
      accountId: config.accountId,
      region: config.region,
      operationId: config.operationId,
      tablePrefix: config.tablePrefix,
      bucket: bucket[0].value,
      cluster: config.cluster,
      service: config.service,
      containerName: lb.containerName,
      containerPort: lb.containerPort,
      taskDefinition: definition.taskDefinitionArn,
      imageDigest: digest,
      runtimeMode: runtimeMode(container),
      listenerArn: config.listenerArn,
      targetGroupA: routing.sourceGroup,
      targetGroupB: routing.candidateGroup,
    };
    return {
      routing,
      expectedSha256: manifestHash(stable),
      m: {
        ...stable,
        principalArn,
        legacyTaskDefinition: svc.taskDefinition,
      },
    };
  }
  async function waitFor(check, timeoutSeconds, message) {
    const deadline = now() + timeoutSeconds;
    while (now() < deadline) {
      if (await check()) return;
      await sleep();
    }
    fail(message);
  }
  async function waitStopped(m) {
    await waitFor(
      async () => {
        const svc = await service();
        if (
          svc.desiredCount !== 0 ||
          svc.taskDefinition !== m.legacyTaskDefinition
        )
          fail("Service changed while stopping");
        return (
          svc.runningCount === 0 &&
          svc.pendingCount === 0 &&
          !(await liveTasks()).length &&
          !(await targets(m.targetGroupA)).length &&
          !(await targets(m.targetGroupB)).length
        );
      },
      STOP_TIMEOUT_SECONDS,
      "Legacy task did not stop within the bounded wait; nothing was relaunched",
    );
  }
  async function promoteWhenReady(boot) {
    const deadline = now() + READY_TIMEOUT_SECONDS;
    while (now() < deadline) {
      if ((await boot.readiness()).kind === "ready")
        try {
          return await boot.promote(deadline);
        } catch (error) {
          // Only pre-write promotion checks emit this code.
          if (error.code !== "candidate_not_ready") throw error;
        }
      await sleep();
    }
    fail(
      "Candidate did not become ready; preserve state and resume with the same operation id",
    );
  }
  async function serving() {
    const control = await read("CONTROL");
    const members = Object.values(control?.servingMembers ?? {});
    if (
      control?.servingGeneration !== 1 ||
      control.coordinatorExpiresAt !== 0 ||
      control.deployment ||
      members.length !== 1 ||
      members[0].candidateId !== config.operationId
    )
      return false;
    const rows = (
      await scan(table, ["recordType", "identity", "role", "readiness"])
    ).filter(
      (row) => row.recordType === "runtime" && same(row.identity, members[0]),
    );
    const proof = rows[0]?.readiness;
    return (
      rows.length === 1 &&
      rows[0].role === "serving" &&
      proof?.observedGeneration === 1 &&
      proof.provenAt <= now() &&
      proof.expiresAt > now()
    );
  }
  async function finish(bound) {
    const boot = bootstrapFactory({
      binding: bound.m,
      expectedSha256: bound.expectedSha256,
      aws,
      now,
      // The cutover's own post-stop recheck replaces the Sandbox maintenance attestation.
      attestSettled: async () => {},
    });
    await boot.initialize();
    log({ phase: "control_initialized" });
    const receipt = await read("BOOTSTRAP#" + config.operationId);
    if (receipt?.stage !== "complete") {
      await boot.launch();
      log({ phase: "candidate_launched" });
      await promoteWhenReady(boot);
      log({ phase: "candidate_promoted" });
    }
    await waitFor(serving, 300, "Promoted candidate has not confirmed serving");
    if ((await read("INTRODUCTION")) !== undefined)
      fail("An introduction hold appeared during the cutover");
  }

  async function inspect() {
    await identity();
    const svc = await service();
    const routing = routingFor(svc);
    const work = await activeWork();
    const controlRows = await countRows(table);
    const listener = await listenerForm(routing);
    const spareTargets = (await targets(routing.candidateGroup)).length;
    return {
      kind: "inspection",
      service: {
        desired: svc.desiredCount,
        running: svc.runningCount,
        pending: svc.pendingCount,
        revision: revision(svc.taskDefinition),
      },
      work: work.counts,
      controlRows,
      listener,
      spareTargets,
      readyForCutover:
        work.total === 0 &&
        controlRows === 0 &&
        listener !== "foreign" &&
        spareTargets === 0,
    };
  }

  async function preflight(svc) {
    if ((await countRows(table)) !== 0)
      fail("Control table already has ownership; inspect before retrying");
    const routing = routingFor(svc);
    const form = await listenerForm(routing);
    if (form === "foreign") fail("Listener routing is not a reviewed form");
    if ((await targets(routing.candidateGroup)).length)
      fail("Spare target group is occupied");
    const steady =
      svc.desiredCount === 1 && svc.runningCount === 1 && !svc.pendingCount;
    if (svc.desiredCount !== 0 && !steady)
      fail("Legacy service is not steady at one task");
    return { routing, form };
  }
  async function preparedCandidate(svc) {
    let definition = await findCandidate(svc);
    if (!definition) definition = await registerCandidate(svc);
    else if (
      taskContainer(definition, config.tablePrefix).image !== config.image
    )
      fail("Operation id is bound to another image; use a new operation id");
    const bound = binding(svc, definition);
    if (bound.m.legacyTaskDefinition === bound.m.taskDefinition)
      fail("Service already runs the candidate without a receipt");
    try {
      assertPreparedCandidate(bound.m, definition);
    } catch {
      fail("Candidate definition would be refused at launch");
    }
    return bound;
  }
  async function stopLegacy() {
    log({ phase: "stop_submitted" });
    const stopped = await aws("ecs", "update-service", {
      cluster: config.cluster,
      service: config.service,
      desiredCount: 0,
    });
    if (stopped.service?.desiredCount !== 0) fail("Stop was not acknowledged");
  }
  /** Without a pre-stop count (service found already stopped) or a recheck, the window cannot be cleared. */
  function stopWindowIncident(before, after) {
    return (
      !before ||
      !after ||
      after.total > 0 ||
      after.counts.meetingHistoryRows !== before.counts.meetingHistoryRows
    );
  }
  async function weightRouting(routing) {
    const changed = await aws("elbv2", "modify-listener", {
      ListenerArn: config.listenerArn,
      DefaultActions: action(routing, false),
    });
    if (
      !same(
        canonical(changed.Listeners?.[0]?.DefaultActions),
        canonical(action(routing, false)),
      )
    )
      fail("Weighted routing was not acknowledged");
    log({ phase: "routing_weighted" });
  }
  async function resume(svc) {
    const definition = await findCandidate(svc);
    if (!definition) fail("Resumed operation has no registered candidate");
    log({ phase: "resuming" });
    await finish(binding(svc, definition));
    return { kind: "complete", resumed: true };
  }

  async function cutover() {
    await identity();
    const svc = await service();
    if (await read("BOOTSTRAP#" + config.operationId)) return resume(svc);
    const { routing, form } = await preflight(svc);
    const bound = await preparedCandidate(svc);
    let before;
    if (svc.desiredCount === 0) log({ phase: "already_stopped" });
    else {
      before = await activeWork();
      log({ phase: "pre_stop_check", work: before.counts });
      if (before.total)
        return {
          kind: "deferred",
          work: before.counts,
          providerMutations: "candidate_definition_only",
        };
      await stopLegacy();
    }
    await waitStopped(bound.m);
    log({ phase: "legacy_stopped" });
    // Service restoration outranks a failed recheck; an unknown answer is reported as an incident.
    const after = await activeWork().catch(() => undefined);
    const incident = stopWindowIncident(before, after);
    log({
      phase: "post_stop_recheck",
      work: after?.counts ?? "unknown",
      incident,
    });
    if (form === "legacy") await weightRouting(routing);
    await finish(bound);
    return {
      kind: "complete",
      resumed: false,
      incident,
      before: before?.counts ?? null,
      after: after?.counts ?? null,
    };
  }
  return { inspect, cutover };
}

async function verifyApproval(env, get) {
  const { nativeGitHub } = require("./terraform-native.cjs");
  const {
    verifyRunApproval,
  } = require("./bootstrap-verification-authority.cjs");
  await verifyRunApproval(
    get ?? nativeGitHub(env.GH_TOKEN),
    { runId: env.GITHUB_RUN_ID, sourceSha: env.GITHUB_SHA },
    WORKFLOW_PATH,
    env.CUTOVER_ENVIRONMENT,
  );
}

async function runCli(mode, env = process.env, deps = {}) {
  const output = deps.output ?? console;
  const log = (event) => output.log(JSON.stringify(event));
  try {
    if (!["inspect", "cutover"].includes(mode)) fail("Unknown mode");
    if (env.GITHUB_RUN_ATTEMPT !== "1")
      fail("Reruns are refused; dispatch a new run");
    const config = cutoverConfig(env, mode);
    const engine = createCutover({
      config,
      aws: deps.aws ?? awsCaller(config.region),
      log,
      now: deps.now,
      sleep: deps.sleep,
      bootstrapFactory: deps.bootstrapFactory,
    });
    if (mode === "inspect") {
      log(await engine.inspect());
      return 0;
    }
    try {
      await (deps.verifyApproval ?? verifyApproval)(env);
    } catch {
      fail(
        "Native approval of this exact run by the configured reviewer is unverified",
      );
    }
    log({ phase: "approval_verified" });
    const result = await engine.cutover();
    log(result);
    if (result.kind === "deferred") {
      output.log(
        "::warning title=Cutover deferred::In-flight work is present. Only the candidate definition may have been registered; the legacy service is untouched. Run inspect and retry in a quiet window.",
      );
      return 0;
    }
    if (result.incident) {
      output.error(
        "::error title=Work appeared during the stop window::The candidate is serving, but a meeting or job may have started on the legacy runtime between the pre-stop check and its shutdown. Review the post_stop_recheck counts and affected meetings now.",
      );
      return 2;
    }
    return 0;
  } catch (error) {
    const reason =
      error instanceof Refusal ? error.message : "unexpected_failure";
    output.error(JSON.stringify({ kind: "cutover_refused", reason }));
    output.error(
      "::error title=Cutover stopped::" +
        reason +
        ". Inspect before acting; resume only with the same operation id. Never relaunch legacy or delete rows.",
    );
    return 1;
  }
}

module.exports = { cutoverConfig, createCutover, runCli, verifyApproval };
if (require.main === module)
  runCli(process.argv[2]).then((code) => {
    process.exitCode = code;
  });
