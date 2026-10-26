/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { readFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runTerraform } from "../../scripts/deployment/terraform-workflow.cjs";
import {
  fixture,
  invocation,
} from "../fixtures/deployment/terraformWorkflow.js";
async function planAndApply(f, patch = {}) {
  const planOptions = f.options(),
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
  f.controls.applyTitle = `Terraform Apply production/default/full plan=10 plan-sha=${plan.planSha256} bundle-sha=${plan.bundleSha256}`;
  const applyOptions = f.options({
    ...invocation,
    workflowPath: ".github/workflows/terraform-apply.yml",
    runId: "20",
  });
  return {
    plan,
    apply: await runTerraform({
      ...applyOptions,
      producerRunId: "10",
      artifactName: "terraform-plan-production-default-10",
      reference,
      planSha256: plan.planSha256,
      bundleSha256: plan.bundleSha256,
      ...patch,
    }),
  };
}
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
        if (current) f.controls.producerSha = "b".repeat(40);
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
