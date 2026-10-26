/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import {
  definitionQuery,
  definitionMetadata,
} from "../../scripts/deployment/production-inventory-adapter.cjs";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { createCandidateInspection } from "../../scripts/deployment/production-candidate.cjs";
const promptConfig = [
  "LANGFUSE_PROMPT_LABEL",
  "LANGFUSE_PROMPT_MEETING_SUMMARY",
  "LANGFUSE_PROMPT_CACHE_TTL_MS",
  "LANGFUSE_PROMPT_NOTES",
  "LANGFUSE_PROMPT_NOTES_LONG_STORY",
  "LANGFUSE_PROMPT_NOTES_CONTEXT_TEST",
  "LANGFUSE_PROMPT_TRANSCRIPTION_CLEANUP",
  "LANGFUSE_PROMPT_TRANSCRIPTION_COALESCE",
  "LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS",
  "LANGFUSE_PROMPT_TRANSCRIPTION",
  "LANGFUSE_PROMPT_IMAGE",
  "LANGFUSE_PROMPT_ASK",
  "LANGFUSE_PROMPT_NOTES_CORRECTION",
  "LANGFUSE_PROMPT_DICTIONARY_TEACHING",
  "LANGFUSE_PROMPT_LIVE_VOICE_GATE",
  "LANGFUSE_PROMPT_LIVE_VOICE_CONFIRM",
  "LANGFUSE_PROMPT_LIVE_VOICE_RESPONDER",
];
const selectedNames = () =>
  JSON.parse(definitionQuery().match(/contains\(`(.*?)`,name\)/)[1]);
test("safe projection includes closed prompt selection settings but excludes bodies and secrets", () => {
  for (const name of promptConfig) expect(selectedNames()).toContain(name);
  for (const name of [
    "LANGFUSE_SECRET_KEY",
    "PROMPT_BODY",
    "SYSTEM_PROMPT",
    "OPENAI_API_KEY",
  ])
    expect(selectedNames()).not.toContain(name);
});
test.each(promptConfig)(
  "changed %s is rejected against reviewed configuration",
  async (name) => {
    const m = completeManifest();
    const definition = {
      taskDefinitionArn: m.runtime.candidateDefinition,
      family: m.runtime.family,
      status: "ACTIVE",
      cpu: "512",
      memory: "1024",
      taskRoleArn: m.resources.taskRoleArn,
      executionRoleArn: m.resources.executionRoleArn,
      containerDefinitions: [
        {
          name: m.runtime.container,
          stopTimeout: 120,
          image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@${m.runtime.candidateDigest}`,
          environment: [
            { name: "DEPLOYMENT_CANDIDATE_ID", value: m.runtime.candidateId },
            { name, value: "approved" },
          ],
          environmentNames: ["DEPLOYMENT_CANDIDATE_ID", name],
        },
      ],
    };
    const project = (d) => ({
      ...d,
      containerDefinitions: d.containerDefinitions.map((c) => ({
        ...c,
        environment: c.environment.filter((e) =>
          selectedNames().includes(e.name),
        ),
      })),
    });
    m.runtime.configurationHash = canonicalHash(
      definitionMetadata(project(definition)),
    );
    definition.containerDefinitions[0].environment[1].value = "changed";
    const aws = jest.fn(async () => ({
      imageDetails: [{ imageDigest: m.runtime.candidateDigest }],
    }));
    const candidate = createCandidateInspection({
      binding: bound(m),
      aws,
      read: jest.fn(),
      now: () => 150,
      definition: async () => project(definition),
    });
    await expect(candidate.definitions()).rejects.toThrow(
      "candidate_configuration_prerequisite",
    );
    expect(aws).not.toHaveBeenCalled();
  },
);
