import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { CONFIG_KEYS } from "../../src/config/keys";
import { buildModelParamKey } from "../../src/config/modelParams";
import { buildModelSelectionKey } from "../../src/config/modelChoices";

const originalNotesModel = process.env.NOTES_MODEL;
const originalResponderModel = process.env.LIVE_VOICE_RESPONDER_MODEL;

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
  if (originalResponderModel === undefined) {
    delete process.env.LIVE_VOICE_RESPONDER_MODEL;
  } else {
    process.env.LIVE_VOICE_RESPONDER_MODEL = originalResponderModel;
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
    model: "gpt-6.2-sol",
  });
  expect(resolved.effectiveNotesParams).toEqual({ reasoning_effort: "low" });
  expect(resolved.params.notes?.samplingMode).toBe("reasoning");
  expect(resolved.getModelChoice("notes")).toEqual(resolved.notes);
  expect(resolved.choices).toMatchObject({
    meetingSummary: "gpt-6.2-sol",
    notesCorrection: "gpt-6.2-sol",
    transcriptionCleanup: "gpt-6.2-sol",
    imagePrompt: "gpt-6.2-sol",
    dictionaryTeaching: "gpt-6.1-terra",
    ask: "gpt-6.1-terra",
    liveVoiceResponder: "gpt-6.1-terra",
    imageCaption: "gpt-6-luna",
    liveVoiceGate: "gpt-6-luna",
    autoRecordCancel: "gpt-6-luna",
    transcription: "gpt-transcribe",
  });
  expect(resolved.getModelChoice("meetingSummary").model).toBe("gpt-6.2-sol");
  expect(resolved.getModelChoice("transcriptionCleanup").model).toBe(
    "gpt-6.2-sol",
  );
});

test("limits an explicit NOTES_MODEL override to notes generation", async () => {
  process.env.NOTES_MODEL = "gpt-6-luna";
  const resolved = await loadModelConfig();

  expect(resolved.notes.model).toBe("gpt-6-luna");
  expect(resolved.getModelChoice("notes").model).toBe("gpt-6-luna");
  expect(resolved.choices.meetingSummary).toBe("gpt-6.2-sol");
  expect(resolved.choices.notesCorrection).toBe("gpt-6.2-sol");
  expect(resolved.choices.transcriptionCleanup).toBe("gpt-6.2-sol");
  expect(resolved.choices.imagePrompt).toBe("gpt-6.2-sol");
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

test("resolves a stored retired chat model to the role default", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.doMock("../../src/services/appConfigService", () => ({
    getGlobalConfigValues: async () => ({
      [buildModelSelectionKey("imageCaption")]: "gpt-4o-mini",
    }),
  }));
  jest.doMock("../../src/services/configOverridesService", () => ({
    listConfigOverridesForScope: async () => [
      { configKey: CONFIG_KEYS.models.ask, value: "gpt-4o-mini" },
      { configKey: CONFIG_KEYS.models.notes, value: "gpt-5.6-sol" },
    ],
  }));
  const resolved = await loadModelConfig();

  expect(resolved.choices.imageCaption).toBe("gpt-6-luna");
  expect(resolved.choices.ask).toBe("gpt-6.1-terra");
  expect(resolved.choices.notes).toBe("gpt-5.6-sol");
  expect(warn).toHaveBeenCalledWith(
    "Stored config value is retired; using the default.",
    expect.objectContaining({ value: "gpt-4o-mini" }),
  );
  warn.mockRestore();
});

test("runs a meeting's saved retired chat choice on the role default", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const { buildModelOverrides, getModelChoice } =
    await import("../../src/services/modelFactory");
  const overrides = buildModelOverrides({
    liveVoiceResponder: "gpt-4o-mini",
    liveVoiceGate: "gpt-5.6-luna",
  });

  expect(getModelChoice("liveVoiceResponder", overrides).model).toBe(
    "gpt-6.1-terra",
  );
  expect(getModelChoice("liveVoiceResponder", overrides).model).toBe(
    "gpt-6.1-terra",
  );
  expect(getModelChoice("liveVoiceGate", overrides).model).toBe("gpt-5.6-luna");
  expect(
    warn.mock.calls.filter(
      ([message]) =>
        message === "Saved model choice is retired; using the default.",
    ),
  ).toHaveLength(1);
  warn.mockRestore();
});

test("ignores a retired environment model default", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env.LIVE_VOICE_RESPONDER_MODEL = "gpt-4o-mini";
  const resolved = await loadModelConfig();

  expect(resolved.choices.ask).toBe("gpt-6.1-terra");
  expect(resolved.choices.liveVoiceResponder).toBe("gpt-6.1-terra");
  warn.mockRestore();
});
