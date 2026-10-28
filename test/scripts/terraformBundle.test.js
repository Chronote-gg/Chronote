/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBundle,
  verifyBundle,
  restoreBundle,
  parseInvocation,
} from "../../scripts/deployment/terraform-bundle.cjs";
import { digest } from "../../scripts/deployment/collector-payload.cjs";
const invocation = {
  repository: "Chronote-gg/Chronote",
  sourceSha: "a".repeat(40),
  workflowPath: ".github/workflows/terraform-plan.yml",
  runId: "10",
  runAttempt: 1,
  environment: "production",
  workspace: "default",
  scope: "full",
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "private-plan-"));
  const plan = Buffer.from([0, 255, 13, 10, 128]),
    zip = Buffer.from([80, 75, 0, 255]);
  writeFileSync(join(directory, "tfplan"), plan);
  writeFileSync(join(directory, "discord_alert.zip"), zip);
  const bundle = createBundle({
    invocation,
    terraformVersion: "1.14.0",
    lockfileSha256: "b".repeat(64),
    directory,
    review: Buffer.from("PRIVATE_REVIEW"),
    output: [{ stdout: "SECRET" }],
  });
  return {
    directory,
    plan,
    zip,
    bundle,
    expected: {
      bundleSha256: digest(JSON.stringify(bundle)),
      planSha256: digest(plan),
      invocation,
      terraformVersion: "1.14.0",
      lockfileSha256: "b".repeat(64),
    },
  };
}
test("whole bundle verifies all original bytes before exact file restoration", () => {
  const f = fixture(),
    destination = mkdtempSync(join(tmpdir(), "restore-plan-"));
  try {
    const files = verifyBundle(f.bundle, f.expected);
    restoreBundle(files, destination);
    expect(readFileSync(join(destination, "tfplan"))).toEqual(f.plan);
    expect(readFileSync(join(destination, "discord_alert.zip"))).toEqual(f.zip);
    expect(
      readFileSync(join(destination, "terraform-review.txt"), "utf8"),
    ).toBe("PRIVATE_REVIEW");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});
test.each([
  "zip-substitution",
  "traversal",
  "duplicate",
  "foreign-file",
  "missing-file",
  "changed-source",
  "changed-run",
  "changed-attempt",
  "changed-environment",
  "changed-scope",
  "changed-version",
  "changed-lock",
  "length",
  "hash",
  "base64",
])("bundle refuses %s even with a matching plan hash", (fault) => {
  const f = fixture();
  try {
    const b = f.bundle;
    const mutations = {
      "zip-substitution": () => {
        b.files.find((file) => file.name === "discord_alert.zip").base64 =
          Buffer.from("replacement").toString("base64");
      },
      traversal: () => {
        b.files[0].name = "../tfplan";
      },
      duplicate: () => {
        b.files.push(b.files[0]);
      },
      "foreign-file": () => {
        b.files[0].name = "evil.zip";
      },
      "missing-file": () => {
        b.files = b.files.filter((file) => file.name !== "discord_alert.zip");
      },
      "changed-source": () => {
        b.invocation.sourceSha = "c".repeat(40);
      },
      "changed-run": () => {
        b.invocation.runId = "11";
      },
      "changed-attempt": () => {
        b.invocation.runAttempt = 2;
      },
      "changed-environment": () => {
        b.invocation.environment = "sandbox";
      },
      "changed-scope": () => {
        b.invocation.scope = "purchase-permission";
      },
      "changed-version": () => {
        b.terraformVersion = "1.15.0";
      },
      "changed-lock": () => {
        b.lockfileSha256 = "c".repeat(64);
      },
      length: () => {
        b.files[0].size++;
      },
      hash: () => {
        b.files[0].sha256 = "c".repeat(64);
      },
      base64: () => {
        b.files[0].base64 += "\n";
      },
    };
    mutations[fault]();
    expect(() => verifyBundle(b, f.expected)).toThrow();
    if (
      ![
        "zip-substitution",
        "changed-source",
        "changed-run",
        "changed-scope",
        "changed-version",
        "changed-lock",
      ].includes(fault)
    ) {
      f.expected.bundleSha256 = digest(JSON.stringify(b));
      expect(() => verifyBundle(b, f.expected)).toThrow();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("invocation rejects reruns, foreign workflows and environment pairing", () => {
  expect(parseInvocation(invocation)).toEqual(invocation);
  for (const patch of [
    { runAttempt: 2 },
    { workspace: "sandbox" },
    { repository: "other/repo" },
    { scope: "arbitrary" },
    { workflowPath: "other" },
  ])
    expect(() => parseInvocation({ ...invocation, ...patch })).toThrow();
});

test("restore refuses existing destinations before writing any file", () => {
  const f = fixture(),
    destination = mkdtempSync(join(tmpdir(), "existing-plan-"));
  try {
    writeFileSync(join(destination, "discord_alert.zip"), "preserved");
    expect(() =>
      restoreBundle(verifyBundle(f.bundle, f.expected), destination),
    ).toThrow();
    expect(readFileSync(join(destination, "discord_alert.zip"), "utf8")).toBe(
      "preserved",
    );
    expect(() => readFileSync(join(destination, "tfplan"))).toThrow();
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test.each(
  ["create", "verify"].flatMap((stage) =>
    [
      "full",
      "purchase-permission",
      "deployment-prerequisites",
      "deployment-runtime",
      undefined,
    ].map((scope) => [stage, scope]),
  ),
)(
  "Sandbox bundle %s refuses unsupported scope %s even when provenance matches",
  (stage, scope) => {
    const f = fixture();
    const unsupported = {
      ...invocation,
      environment: "sandbox",
      workspace: "sandbox",
      scope,
    };
    try {
      if (stage === "create")
        expect(() =>
          createBundle({
            invocation: unsupported,
            terraformVersion: f.bundle.terraformVersion,
            lockfileSha256: f.bundle.lockfileSha256,
            directory: f.directory,
            review: Buffer.from("PRIVATE_REVIEW"),
            output: [],
          }),
        ).toThrow();
      else {
        f.bundle.invocation = unsupported;
        expect(() =>
          verifyBundle(f.bundle, {
            ...f.expected,
            invocation: unsupported,
            bundleSha256: digest(JSON.stringify(f.bundle)),
          }),
        ).toThrow();
      }
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
