/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import {
  definitionMetadata,
  definitionQuery,
} from "../../scripts/deployment/production-inventory-adapter.cjs";
import {
  createCandidateInspection,
  candidateSlot,
} from "../../scripts/deployment/production-candidate.cjs";
import { projection } from "../../scripts/deployment/production-projections.cjs";

function candidate(change) {
  const m = completeManifest();
  const c = {
    name: m.runtime.container,
    stopTimeout: 120,
    command: ["node", "dist/index.js"],
    image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@${m.runtime.candidateDigest}`,
    environment: [
      { name: "DEPLOYMENT_CANDIDATE_ID", value: m.runtime.candidateId },
    ],
    environmentNames: ["DEPLOYMENT_CANDIDATE_ID"],
    secrets: [],
    environmentFiles: [],
  };
  change(c);
  const d = {
    family: m.runtime.family,
    status: "ACTIVE",
    cpu: "512",
    memory: "1024",
    taskRoleArn: m.resources.taskRoleArn,
    executionRoleArn: m.resources.executionRoleArn,
    containerDefinitions: [c],
  };
  m.runtime.configurationHash = canonicalHash(definitionMetadata(d));
  let digest = m.runtime.candidateDigest;
  const aws = jest.fn(async () => ({
    imageDetails: [{ imageDigest: digest }],
  }));
  const definition = async (arn) => {
    const slot = ["bootstrap", "replacement", "handoff"]
      .map((name) => candidateSlot(m, name))
      .find((s) => s.definition === arn);
    const value = structuredClone(d);
    value.containerDefinitions[0].environment[0].value = slot.candidateId;
    value.containerDefinitions[0].image = c.image.replace(
      m.runtime.candidateDigest,
      slot.digest,
    );
    digest = slot.digest;
    return value;
  };
  return {
    aws,
    inspection: createCandidateInspection({
      binding: bound(m),
      aws,
      read: jest.fn(),
      now: () => 150,
      definition,
    }),
  };
}

test("ordinary reviewed runtime definitions retain generated instance identities", async () => {
  const { inspection, aws } = candidate(() => {});
  await expect(inspection.definitions()).resolves.toBeUndefined();
  expect(aws).toHaveBeenCalledTimes(3);
});

test.each([
  [
    "entrypoint",
    (c) => {
      c.entryPoint = [
        "sh",
        "-c",
        "export BOT_INSTANCE_ID=fixed; exec node dist/index.js",
      ];
    },
  ],
  [
    "command",
    (c) => {
      c.command = [
        "sh",
        "-c",
        "export BOT_INSTANCE_ID=fixed; exec node dist/index.js",
      ];
    },
  ],
  [
    "environment",
    (c) => {
      c.environmentNames.push("BOT_INSTANCE_ID");
    },
  ],
  [
    "secret",
    (c) => {
      c.secrets.push({ name: "BOT_INSTANCE_ID", valueFrom: "dummy-reference" });
    },
  ],
  [
    "environment file",
    (c) => {
      c.environmentFiles.push({ type: "s3", value: "dummy-reference" });
    },
  ],
])(
  "actual candidate definitions refuse %s identity overrides even with a matching configuration hash",
  async (_, change) => {
    const { inspection, aws } = candidate(change);
    await expect(inspection.definitions()).rejects.toThrow();
    expect(aws).not.toHaveBeenCalled();
  },
);

test("safe actual provider projections retain identity override presence", () => {
  expect(definitionQuery()).toContain("environmentFiles:environmentFiles");
  expect(projection("ecs", "describe-tasks")).toContain(
    "overrides:overrides.containerOverrides",
  );
  expect(projection("ecs", "describe-tasks")).toContain(
    "environmentNames:environment[].name",
  );
});
