import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { CONFIG_KEYS } from "../../src/config/keys";
import { buildModelParamKey } from "../../src/config/modelParams";

const originalNotesModel = process.env.NOTES_MODEL;

beforeEach(() => {
  jest.resetModules();
  process.env.NOTES_MODEL = "";
  jest.doMock("../../src/services/appConfigService", () => ({
    getGlobalConfigValues: async () => ({}),
  }));
  jest.doMock("../../src/services/configOverridesService", () => ({
    listConfigOverridesForScope: async () => [],
  }));
});

afterEach(() => {
  if (originalNotesModel === undefined) {
    delete process.env.NOTES_MODEL;
  } else {
    process.env.NOTES_MODEL = originalNotesModel;
  }
  jest.dontMock("../../src/services/appConfigService");
  jest.dontMock("../../src/services/configOverridesService");
  jest.resetModules();
});

const loadModelConfig = async () => {
  const { resolveConfigSnapshot } =
    await import("../../src/services/unifiedConfigService");
  const { resolveModelChoicesByRole } =
    await import("../../src/services/modelChoiceService");
  const { buildModelOverrides, getModelChoice } =
    await import("../../src/services/modelFactory");
  const { resolveChatParamsForRole, resolveModelParamsByRole } =
    await import("../../src/services/openaiModelParams");
  const snapshot = await resolveConfigSnapshot({ guildId: "test-guild" });
  const choices = resolveModelChoicesByRole(snapshot);
  const params = resolveModelParamsByRole(snapshot);
  const overrides = buildModelOverrides(choices);
  const notes = getModelChoice("notes", overrides);

  return {
    snapshot,
    choices,
    params,
    notes,
    effectiveNotesParams: resolveChatParamsForRole({
      role: "notes",
      model: notes.model,
      config: params.notes,
    }),
    getModelChoice,
  };
};

test("resolves the configured notes default to Sol with low reasoning", async () => {
  const resolved = await loadModelConfig();

  expect(resolved.notes).toEqual({
    provider: "openai",
    model: "gpt-6.1-sol",
  });
  expect(resolved.effectiveNotesParams).toEqual({ reasoning_effort: "low" });
  expect(resolved.params.notes?.samplingMode).toBe("reasoning");
  expect(resolved.getModelChoice("notes")).toEqual(resolved.notes);
  expect(resolved.choices).toMatchObject({
    meetingSummary: "gpt-5.2",
    notesCorrection: "gpt-5.2",
    transcriptionCleanup: "gpt-5.2",
    imagePrompt: "gpt-5.2",
    transcription: "gpt-4o-transcribe",
  });
  expect(resolved.getModelChoice("meetingSummary").model).toBe("gpt-5.2");
  expect(resolved.getModelChoice("transcriptionCleanup").model).toBe("gpt-5.2");
});

test("limits an explicit NOTES_MODEL override to notes generation", async () => {
  process.env.NOTES_MODEL = "gpt-6-luna";
  const resolved = await loadModelConfig();

  expect(resolved.notes.model).toBe("gpt-6-luna");
  expect(resolved.getModelChoice("notes").model).toBe("gpt-6-luna");
  expect(resolved.choices.meetingSummary).toBe("gpt-5.2");
  expect(resolved.choices.notesCorrection).toBe("gpt-5.2");
  expect(resolved.choices.transcriptionCleanup).toBe("gpt-5.2");
  expect(resolved.choices.imagePrompt).toBe("gpt-5.2");
});

test("preserves a saved server model and temperature profile over global defaults", async () => {
  jest.doMock("../../src/services/appConfigService", () => ({
    getGlobalConfigValues: async () => ({
      [CONFIG_KEYS.models.notes]: "gpt-6-astra",
      [buildModelParamKey("notes", "reasoningEffort")]: "high",
    }),
  }));
  jest.doMock("../../src/services/configOverridesService", () => ({
    listConfigOverridesForScope: async () => [
      { configKey: CONFIG_KEYS.models.notes, value: "gpt-5.2" },
      {
        configKey: buildModelParamKey("notes", "samplingMode"),
        value: "temperature",
      },
      { configKey: buildModelParamKey("notes", "temperature"), value: 0.3 },
      { configKey: buildModelParamKey("notes", "verbosity"), value: "high" },
    ],
  }));
  const resolved = await loadModelConfig();

  expect(resolved.notes.model).toBe("gpt-5.2");
  expect(resolved.snapshot.values[CONFIG_KEYS.models.notes].source).toBe(
    "server",
  );
  expect(resolved.effectiveNotesParams).toEqual({
    reasoning_effort: "none",
    temperature: 0.3,
    verbosity: "high",
  });
});

test("keeps explicit Sol reasoning and verbosity overrides", async () => {
  jest.doMock("../../src/services/appConfigService", () => ({
    getGlobalConfigValues: async () => ({
      [buildModelParamKey("notes", "reasoningEffort")]: "high",
      [buildModelParamKey("notes", "verbosity")]: "low",
    }),
  }));
  const resolved = await loadModelConfig();

  expect(resolved.effectiveNotesParams).toEqual({
    reasoning_effort: "high",
    verbosity: "low",
  });
});
