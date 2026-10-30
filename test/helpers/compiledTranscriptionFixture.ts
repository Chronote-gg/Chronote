import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TRANSCRIPTION_IMPLEMENTATION_SOURCES,
  writeTranscriptionBuildAssociation,
} from "../../src/evals/transcriptionImplementation";
import {
  compileSpeechFixture,
  removeOwnedFixture,
} from "./compiledSpeechDetectionFixture";

// Current-source setup exceeded 60s in CI before any provenance assertion ran.
export const TRANSCRIPTION_FIXTURE_SETUP_TIMEOUT_MS = 120000;

export async function prepareTranscriptionFixture(
  root: string,
  dependencyRoot = root,
): Promise<string> {
  const fixture = mkdtempSync(
    path.join(tmpdir(), "vad-build-contract-compiled-"),
  );
  try {
    const sources = compileSpeechFixture(
      root,
      fixture,
      [
        "evals/transcriptionEval.ts",
        ...TRANSCRIPTION_IMPLEMENTATION_SOURCES.map((file) => file.slice(4)),
      ],
      dependencyRoot,
    );
    for (const file of [
      ...sources,
      "package.json",
      "tsconfig.json",
      "yarn.lock",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      cpSync(path.join(root, file), path.join(fixture, file));
    }
    await writeTranscriptionBuildAssociation(fixture);
    return fixture;
  } catch (error) {
    removeOwnedFixture(fixture, "vad-build-contract-");
    throw error;
  }
}

export async function prepareTranscriptionAcceptanceFixture(
  root: string,
  dependencyRoot = root,
): Promise<string> {
  const fixture = await prepareTranscriptionFixture(root, dependencyRoot);
  try {
    const scripts = "scripts/speech-detection";
    mkdirSync(path.join(fixture, scripts), { recursive: true });
    for (const file of [
      "check-acceptance.mjs",
      "acceptance-evidence.mjs",
      "assessment-stats.mjs",
      "evidence.mjs",
    ])
      cpSync(path.join(root, scripts, file), path.join(fixture, scripts, file));
    // ESM package resolution does not use NODE_PATH. Copy its one script dependency
    // into the owned fixture; CommonJS dependencies remain read-only through NODE_PATH.
    cpSync(
      path.join(dependencyRoot, "node_modules/zod"),
      path.join(fixture, "node_modules/zod"),
      { recursive: true },
    );
    return fixture;
  } catch (error) {
    removeOwnedFixture(fixture, "vad-build-contract-");
    throw error;
  }
}

export function copyTranscriptionSourceCheckout(
  root: string,
  checkout: string,
) {
  for (const file of [
    "src",
    "assets",
    "scripts",
    "package.json",
    "tsconfig.json",
    "yarn.lock",
  ]) {
    cpSync(path.join(root, file), path.join(checkout, file), {
      recursive: true,
      filter: (source) =>
        source !== path.join(root, "src/frontend") &&
        source !== path.join(root, "src/setupTests.ts"),
    });
  }
}

export function unreviewedPcmManifest(pcm: Buffer, name: string) {
  return {
    version: 1,
    name,
    prompt: "",
    cases: [
      {
        id: "one",
        file: "control.pcm",
        sha256: createHash("sha256").update(pcm).digest("hex"),
        split: "holdout",
        label: { kind: "unreviewed" },
      },
    ],
  };
}

export function useCompiledTranscriptionFixture(
  root: string,
  ready: (directory: string) => void,
) {
  let compiled: string;
  beforeAll(async () => {
    compiled = await prepareTranscriptionFixture(root);
    ready(compiled);
  }, TRANSCRIPTION_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(() => {
    if (compiled) removeOwnedFixture(compiled, "vad-build-contract-");
  });
}
