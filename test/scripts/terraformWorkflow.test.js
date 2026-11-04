/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import {
  readFileSync,
  rmSync,
  readdirSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
import { dispatchTerraform } from "../fixtures/deployment/terraformDispatch.js";
import { runtimePlan } from "../fixtures/deployment/runtimePlan.js";
import { meetingUpdatePlan } from "../fixtures/deployment/terraformMeetingUpdate.js";
import { sitePlan } from "../fixtures/deployment/sitePlan.js";
import {
  sitePermissionsPlan,
  siteVariables,
} from "../fixtures/deployment/sandboxSitePermissionsPlan.js";
import {
  processingRetryPlan,
  tableAddress,
} from "../fixtures/deployment/processingRetryPlan.js";
async function planAndApply(
  f,
  patch = {},
  scope = "full",
  execute = runTerraform,
  current = invocation,
) {
  const planOptions = f.options({ ...current, scope }),
    plan = await runTerraform(planOptions);
  expect({
    status: plan.status,
    error:
      plan.status === "planned-changes"
        ? null
        : readFileSync(
            join(planOptions.privateDirectory, "failure.txt"),
            "utf8",
          ),
  }).toEqual({ status: "planned-changes", error: null });
  const reference = JSON.parse(
    readFileSync(
      join(planOptions.privateDirectory, "bundle-reference.json"),
      "utf8",
    ),
  );
  for (const name of readdirSync(join(f.directory, "_infra")))
    if (name !== ".terraform.lock.hcl" && name !== "terraform.auto.tfvars.json")
      rmSync(join(f.directory, "_infra", name));
  f.controls.applyTitle = `Terraform Apply ${current.environment}/${current.workspace}/${scope} plan=10 plan-sha=${plan.planSha256} bundle-sha=${plan.bundleSha256}`;
  const applyOptions = f.options({
    ...current,
    scope,
    workflowPath: ".github/workflows/terraform-apply.yml",
    runId: "20",
  });
  return {
    plan,
    apply: await execute({
      ...applyOptions,
      producerRunId: "10",
      artifactName: `terraform-plan-${current.environment}-${current.workspace}-10`,
      reference,
      planSha256: plan.planSha256,
      bundleSha256: plan.bundleSha256,
      ...patch,
    }),
  };
}
// A bound scope reads the plan JSON at Plan and again before Apply.
function expectRevalidated(f) {
  expect(
    f.commands.filter((c) => c.args[1] === "show" && c.args.includes("-json")),
  ).toHaveLength(2);
}
// Plans and applies `scope`, expecting `status`, a matching apply count and,
// for a refusal, the private failure reason.
async function expectApply(f, status, { scope = "full", reason } = {}) {
  try {
    const { apply } = await planAndApply(f, {}, scope);
    expect(apply.status).toBe(status);
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
      status === "applied" ? 1 : 0,
    );
    if (reason)
      expect(
        readFileSync(join(f.directory, "private-20", "failure.txt"), "utf8"),
      ).toContain(reason);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
}
test.each([
  ["sandbox", "sandbox", "meeting-update-delivery", "default", false],
  ["production", "default", "full", "sandbox", false],
  ["production", "default", "full", "sandbox", true],
])(
  "%s Plan and Apply bind init to the validated workspace before workspace selection",
  async (
    environment,
    workspace,
    scope,
    inheritedWorkspace,
    missingWorkspace,
  ) => {
    const f = fixture(),
      originalOptions = f.options,
      initWorkspaces = [],
      workspaceCommands = [],
      boundWorkspaces = [];
    f.controls.environment = environment;
    f.controls.missingWorkspace = missingWorkspace;
    if (environment === "sandbox") f.controls.planJson = meetingUpdatePlan();
    f.options = (current) => {
      const options = originalOptions(current),
        command = options.command;
      options.env = { ...options.env, TF_WORKSPACE: inheritedWorkspace };
      options.command = async (file, args, settings) => {
        if (file === "terraform" && args[1] === "init")
          initWorkspaces.push(settings.env.TF_WORKSPACE);
        if (file === "terraform") {
          if (args[1] === "workspace")
            workspaceCommands.push({
              args: args.slice(1),
              workspace: settings.env.TF_WORKSPACE,
            });
          else boundWorkspaces.push(settings.env.TF_WORKSPACE);
        }
        const result = await command(file, args, settings);
        if (
          file === "terraform" &&
          args[1] === "workspace" &&
          args[2] === "new"
        )
          f.controls.missingWorkspace = false;
        return result;
      };
      return options;
    };
    try {
      const { apply } = await planAndApply(f, {}, scope, runTerraform, {
        ...invocation,
        environment,
        workspace,
      });
      expect(apply.status).toBe("applied");
      expect(initWorkspaces).toEqual([workspace, workspace]);
      expect(boundWorkspaces.every((value) => value === workspace)).toBe(true);
      expect(workspaceCommands).toEqual([
        { args: ["workspace", "select", workspace], workspace: undefined },
        ...(missingWorkspace
          ? [{ args: ["workspace", "new", workspace], workspace: undefined }]
          : []),
        { args: ["workspace", "select", workspace], workspace: undefined },
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "actual prerequisite dispatcher requires acknowledged show before bundle reference (show failure %s)",
  async (failShow) => {
    const f = fixture();
    f.controls.fail = failShow ? "show" : "";
    const options = f.options({
      ...invocation,
      scope: "deployment-prerequisites",
    });
    try {
      const result = await dispatchTerraform(options);
      expect(result.status).toBe(failShow ? "failed" : "planned-changes");
      expect(f.commands.some((command) => command.args[1] === "show")).toBe(
        true,
      );
      expect(
        existsSync(
          join(f.directory, "chronote-terraform-10-1", "bundle-reference.json"),
        ),
      ).toBe(!failShow);
      expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_REVIEW/);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
test.each([0, 2, 1])(
  "private plan captures exit %s without public secret bytes",
  async (exitCode) => {
    const f = fixture();
    f.controls.exitCode = exitCode;
    try {
      const result = await runTerraform(f.options());
      expect(result.status).toBe(
        exitCode === 0
          ? "planned-no-changes"
          : exitCode === 2
            ? "planned-changes"
            : "failed",
      );
      expect(JSON.stringify(result)).not.toMatch(
        /SECRET|PRIVATE_REVIEW|bucket|versionId/,
      );
      expect(
        [...f.storage.objects.values()].some((bytes) =>
          bytes.includes(Buffer.from("U0VDUkVU")),
        ),
      ).toBe(true);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
test("authenticated producer, approval and whole bundle restore apply the exact saved plan", async () => {
  const f = fixture();
  try {
    const { apply } = await planAndApply(f);
    expect(apply.status).toBe("applied");
    expect(
      f.commands.filter((c) => c.args[1] === "apply").map((c) => c.args),
    ).toEqual([
      ["-chdir=_infra", "apply", "-no-color", "-input=false", "tfplan"],
    ]);
    expect(f.commands.filter((c) => c.args[1] === "plan")).toHaveLength(1);
    expect(readFileSync(join(f.directory, "_infra/tfplan"))).toEqual(
      Buffer.from([0, 255, 13, 10]),
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test.each([
  "storage",
  "bundle",
  "producer-source",
  "producer-time",
  "protection-drift",
  "apply-ack",
])("workflow refuses or preserves unknown %s without retry", async (fault) => {
  const f = fixture();
  try {
    if (fault === "storage") {
      const result = await runTerraform({ ...f.options(), binding: undefined });
      expect(result.status).toBe("refused");
      expect(f.commands).toHaveLength(0);
      return;
    }
    if (fault === "producer-source") f.controls.producerSha = "b".repeat(40);
    if (fault === "producer-time") f.controls.producerAfter = true;
    if (fault === "protection-drift") f.controls.envChange = true;
    if (fault === "apply-ack") f.controls.lostApply = true;
    // Producer mismatch is introduced after its own trusted plan run has completed.
    const originalCommand = f.options;
    if (fault === "producer-source") {
      f.controls.producerSha = invocation.sourceSha;
      f.options = (current) => {
        if (current?.workflowPath.endsWith("terraform-apply.yml"))
          f.controls.producerSha = "b".repeat(40);
        return originalCommand(current);
      };
    }
    const { apply } = await planAndApply(
      f,
      fault === "bundle" ? { bundleSha256: "c".repeat(64) } : {},
    );
    expect(apply.status).toBe(fault === "apply-ack" ? "unknown" : "refused");
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
      fault === "apply-ack" ? 1 : 0,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// The plan runs at the fixture source; Apply runs at `applySha`, and the plan
// run may later report `reportedPlanSha` as its source.
function laterApply(f, applySha, files, reportedPlanSha) {
  f.controls.compare = {
    status: "ahead",
    merge_base_commit: { sha: reportedPlanSha ?? invocation.sourceSha },
    files: files.map((filename) => ({ filename })),
  };
  const options = f.options;
  f.options = (current) => {
    if (!current?.workflowPath.endsWith("terraform-apply.yml"))
      return options(current);
    f.controls.applySha = applySha;
    if (reportedPlanSha) f.controls.producerSha = reportedPlanSha;
    return options({ ...current, sourceSha: applySha });
  };
}
test.each([
  ["docs/production-introduction.md", "applied", undefined],
  ["_infra/main.tf", "refused", "Terraform input changed"],
])(
  "Apply on a later master commit that changes only %s is %s",
  async (path, status, reason) => {
    const f = fixture();
    laterApply(f, "b".repeat(40), [path]);
    await expectApply(f, status, { reason });
  },
);

test("a plan run that reports another source cannot borrow the reviewed bundle", async () => {
  const f = fixture();
  laterApply(f, "c".repeat(40), ["docs/a.md"], "b".repeat(40));
  await expectApply(f, "refused");
});

test("a production plan run from another branch is refused", async () => {
  const f = fixture();
  f.controls.producerBranch = "feature";
  await expectApply(f, "refused");
});

test.each([
  "deploy.yml",
  "production-cutover.yml",
  "introduce-production.yml",
  "production-introduction.yml",
])("Apply refuses while %s has an active run", async (workflow) => {
  const f = fixture();
  f.controls.busyWorkflow = workflow;
  await expectApply(f, "refused", { reason: `Production writer ${workflow}` });
});

test("lost capture acknowledgment preserves the intent and never starts Terraform or retries", async () => {
  const f = fixture();
  try {
    const send = f.storage.client.send;
    f.storage.client.send = async (command) => {
      const result = await send(command);
      if (command.constructor.name === "PutObjectCommand")
        throw new Error("SECRET_CAPTURE_RESPONSE");
      return result;
    };
    const options = f.options(),
      result = await runTerraform(options);
    expect(result).toEqual({ status: "unknown" });
    expect(f.commands).toHaveLength(0);
    expect(
      f.storage.calls.filter((c) => c.constructor.name === "PutObjectCommand"),
    ).toHaveLength(1);
    expect(
      readFileSync(join(options.privateDirectory, "capture-0.json"), "utf8"),
    ).toContain("terraform-plan-intent-v1");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("lost durable apply output acknowledgment never repeats the applied command", async () => {
  const f = fixture();
  try {
    const send = f.storage.client.send;
    f.storage.client.send = async (command) => {
      const result = await send(command);
      if (command.constructor.name === "PutObjectCommand") {
        const value = JSON.parse(command.input.Body);
        if (
          value.kind === "terraform-execution-output-v1" &&
          value.invocation.runId === "20"
        )
          throw new Error("SECRET_OUTPUT_RESPONSE");
      }
      return result;
    };
    const { apply } = await planAndApply(f);
    expect(apply).toEqual({ status: "unknown" });
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(1);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test.each(["init", "workspace", "validate", "show"])(
  "failed %s output stays private and prevents apply",
  async (fail) => {
    const f = fixture();
    f.controls.fail = fail;
    try {
      const result = await runTerraform(f.options());
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/);
      expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(0);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each(["canceled", "capture-bound"])(
  "unknown command %s preserves output and never retries",
  async (fault) => {
    const f = fixture();
    try {
      const options = f.options(),
        command = options.command;
      options.command = async (...args) => {
        const value = await command(...args);
        if (fault === "capture-bound")
          throw new Error("UNKNOWN: SECRET output exceeds bound");
        return { ...value, outcome: "unknown", exitCode: null };
      };
      expect(await runTerraform(options)).toEqual({ status: "unknown" });
      expect(f.commands).toHaveLength(1);
      expect(readdirSync(options.privateDirectory)).toContain("0.stdout");
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test("failure-file persistence after apply begins preserves unknown and never retries", async () => {
  const f = fixture(),
    originalOptions = f.options;
  f.options = (current) => {
    const options = originalOptions(current),
      command = options.command;
    options.command = async (file, args, settings) => {
      const result = await command(file, args, settings);
      if (args[1] === "apply") {
        mkdirSync(join(options.privateDirectory, "failure.txt"));
        return { ...result, outcome: "unknown", exitCode: null };
      }
      return result;
    };
    return options;
  };
  try {
    const result = await planAndApply(f);
    expect(result.apply).toEqual({ status: "unknown" });
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(1);
    expect(readdirSync(join(f.directory, "private-20", "failure.txt"))).toEqual(
      [],
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("local failure-detail error before execution preserves refusal", async () => {
  const f = fixture();
  try {
    const options = f.options();
    mkdirSync(join(options.privateDirectory, "failure.txt"));
    expect(await runTerraform({ ...options, binding: undefined })).toEqual({
      status: "refused",
    });
    expect(f.commands).toHaveLength(0);
    expect(readdirSync(join(options.privateDirectory, "failure.txt"))).toEqual(
      [],
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test.each(["full", "deployment-prerequisites"])(
  "private %s Apply checks the real hold guard and missing-Control exception",
  async (scope) => {
    const f = fixture();
    f.guard.failure = "ResourceNotFoundException";
    try {
      const { apply } = await planAndApply(f, {}, scope);
      expect(apply.status).toBe(
        scope === "deployment-prerequisites" ? "applied" : "refused",
      );
      expect(f.guard.reads).toBeGreaterThanOrEqual(2);
      expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
        scope === "deployment-prerequisites" ? 1 : 0,
      );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["", "applied"],
  ["ResourceNotFoundException", "refused"],
])(
  "runtime Apply revalidates its plan and needs the Control table (guard failure %j)",
  async (failure, status) => {
    const f = fixture();
    f.controls.planJson = runtimePlan();
    f.guard.failure = failure;
    await expectApply(f, status, { scope: "deployment-runtime" });
    expectRevalidated(f);
  },
);

test("site delivery Apply revalidates its restored plan", async () => {
  const f = fixture();
  f.controls.planJson = sitePlan();
  await expectApply(f, "applied", { scope: "site-delivery" });
  expectRevalidated(f);
});

test.each([
  "none",
  "plan-policy",
  "apply-policy",
  "apply-selector",
  "malformed-variables",
])("Sandbox site permissions private transport: %s", async (fault) => {
  const f = fixture();
  const current = {
    ...invocation,
    environment: "sandbox",
    workspace: "sandbox",
  };
  f.controls.environment = "sandbox";
  f.controls.planJson = sitePermissionsPlan();
  const original = f.options;
  f.options = (i) => {
    const opts = original(i);
    writeFileSync(
      join(f.directory, "_infra/site-publishing.tf"),
      readFileSync("_infra/site-publishing.tf"),
    );
    opts.env = {
      ...opts.env,
      GITHUB_VARS_JSON:
        fault === "malformed-variables"
          ? "[]"
          : JSON.stringify(siteVariables()),
    };
    if (
      fault === "apply-selector" &&
      i.workflowPath.endsWith("terraform-apply.yml")
    )
      opts.env.GITHUB_VARS_JSON = JSON.stringify({
        ...siteVariables(),
        DOCS_BUCKET: "other-site-bucket",
      });
    return opts;
  };
  const corrupt = () => {
    f.controls.planJson.resource_changes.find(
      (r) => r.address === "aws_iam_policy.site_publishing[0]",
    ).change.after.policy = "{}";
  };
  try {
    if (["plan-policy", "malformed-variables"].includes(fault)) {
      if (fault === "plan-policy") corrupt();
      const opts = f.options({ ...current, scope: "sandbox-site-permissions" });
      expect((await runTerraform(opts)).status).toBe("failed");
      expect(
        existsSync(join(opts.privateDirectory, "bundle-reference.json")),
      ).toBe(false);
    } else {
      const { apply } = await planAndApply(
        f,
        {},
        "sandbox-site-permissions",
        (opts) => {
          if (fault === "apply-policy") corrupt();
          return runTerraform(opts);
        },
        current,
      );
      expect(apply.status).toBe(fault === "none" ? "applied" : "refused");
      expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
        fault === "none" ? 1 : 0,
      );
      expectRevalidated(f);
    }
    if (fault !== "malformed-variables")
      expect(
        f.commands
          .find((c) => c.args[1] === "plan")
          .args.filter((arg) => arg.startsWith("-target=")),
      ).toEqual([
        "-target=aws_iam_policy.site_publishing[0]",
        "-target=aws_iam_role_policy_attachment.site_publishing[0]",
      ]);
    const bundle = [...f.storage.objects.values()]
      .map((v) => JSON.parse(v))
      .find((v) => v.kind === "terraform-plan-bundle-v1");
    expect(Boolean(bundle)).toBe(
      !["plan-policy", "malformed-variables"].includes(fault),
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// Plans and applies `scope`, expecting Apply to refuse before Terraform apply runs.
async function expectApplyRefused(f, scope, execute) {
  try {
    const { apply } = await planAndApply(f, {}, scope, execute);
    expect(apply.status).toBe("refused");
    expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(0);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
}

test("processing retry Apply refuses a restored plan that changes the table further", async () => {
  const f = fixture();
  f.controls.planJson = processingRetryPlan();
  await expectApplyRefused(f, "processing-retry", (options) => {
    f.controls.planJson.resource_changes.find(
      (r) => r.address === tableAddress,
    ).change.after.billing_mode = "PROVISIONED";
    return runTerraform(options);
  });
});

test.each([
  [
    "a later commit that changes a Terraform input",
    (f) => laterApply(f, "b".repeat(40), ["_infra/main.tf"]),
    "Terraform input changed",
  ],
  [
    "an active deploy",
    (f) => (f.controls.busyWorkflow = "deploy.yml"),
    "Production writer deploy.yml",
  ],
])("processing retry Apply refuses %s", async (_name, arrange, reason) => {
  const f = fixture();
  f.controls.planJson = processingRetryPlan();
  arrange(f);
  await expectApply(f, "refused", { scope: "processing-retry", reason });
});

test("runtime Plan refuses to bundle a serving service change", async () => {
  const f = fixture();
  f.controls.planJson = runtimePlan();
  f.controls.planJson.resource_changes.push({
    address: "aws_ecs_service.app_service",
    mode: "managed",
    change: { actions: ["update"] },
  });
  try {
    const options = f.options({ ...invocation, scope: "deployment-runtime" });
    expect((await runTerraform(options)).status).toBe("failed");
    expect(
      existsSync(join(options.privateDirectory, "bundle-reference.json")),
    ).toBe(false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("even an authenticated prerequisite bundle cannot bypass a denied Control read", async () => {
  const f = fixture();
  f.guard.failure = "AccessDeniedException";
  await expectApplyRefused(f, "deployment-prerequisites");
});

test.each(["full", "deployment-prerequisites"])(
  "actual dispatcher carries %s to the real Apply guard",
  async (scope) => {
    const f = fixture();
    f.guard.failure = "ResourceNotFoundException";
    try {
      const { apply } = await planAndApply(f, {}, scope, dispatchTerraform);
      expect(apply.status).toBe(scope === "full" ? "refused" : "applied");
      expect(f.guard.reads).toBeGreaterThanOrEqual(2);
      expect(
        f.commands.filter((command) => command.args[1] === "apply"),
      ).toHaveLength(scope === "full" ? 0 : 1);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

test.each(["missing-type", "before-apply", "after-apply"])(
  "actual private workflow retains branch proof and refuses drift: %s",
  async (fault) => {
    const f = fixture();
    f.controls.branchPolicyFault = fault === "missing-type";
    f.controls.branchPolicyDrift = fault;
    let bundleReads;
    try {
      const { apply } = await planAndApply(f, {}, "full", async (options) => {
        const before = f.storage.calls.length;
        const result = await runTerraform(options);
        bundleReads = f.storage.calls
          .slice(before)
          .filter(
            (c) =>
              c.constructor.name === "GetObjectCommand" &&
              c.input.Key === options.reference.key,
          );
        return result;
      });
      expect(apply.status).toBe(
        fault === "after-apply" ? "unknown" : "refused",
      );
      expect(f.commands.filter((c) => c.args[1] === "apply")).toHaveLength(
        fault === "after-apply" ? 1 : 0,
      );
      expect(bundleReads).toHaveLength(fault === "missing-type" ? 0 : 1);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
