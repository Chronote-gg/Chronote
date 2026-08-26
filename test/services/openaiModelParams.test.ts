import { expect, test } from "@jest/globals";
import type { ModelParamRole } from "../../src/config/types";
import { resolveChatParamsForRole } from "../../src/services/openaiModelParams";

const baseConfig = {
  samplingMode: "temperature" as const,
  reasoningEffort: "low" as const,
  temperature: 0,
  verbosity: "default" as const,
};

test("drops temperature for gpt-5-mini and falls back to reasoning", () => {
  const params = resolveChatParamsForRole({
    role: "notes",
    model: "gpt-5-mini",
    config: baseConfig,
  });

  expect(params.temperature).toBeUndefined();
  expect(params.reasoning_effort).toBe("low");
});

test("uses temperature with reasoning none for gpt-5.2", () => {
  const params = resolveChatParamsForRole({
    role: "notes",
    model: "gpt-5.2",
    config: { ...baseConfig, temperature: 0.2 },
  });

  expect(params.temperature).toBe(0.2);
  expect(params.reasoning_effort).toBe("none");
});

test.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
  "preserves the temperature-mode compatibility baseline for %s",
  (model) => {
    const params = resolveChatParamsForRole({
      role: "notes",
      model,
      config: { ...baseConfig, temperature: 0.2 },
    });

    expect(params.temperature).toBe(0.2);
    expect(params.reasoning_effort).toBe("none");
  },
);

const solRolloutRoles = [
  "notes",
  "meetingSummary",
  "notesCorrection",
  "transcriptionCleanup",
  "imagePrompt",
] satisfies ModelParamRole[];

test.each(solRolloutRoles)(
  "uses explicit low reasoning for the staged Sol profile on %s",
  (role) => {
    const params = resolveChatParamsForRole({
      role,
      model: "gpt-5.6-sol",
      config: {
        ...baseConfig,
        samplingMode: "reasoning",
        reasoningEffort: "low",
      },
    });

    expect(params.temperature).toBeUndefined();
    expect(params.reasoning_effort).toBe("low");
  },
);

test("supports explicit max reasoning for GPT-5.6", () => {
  const params = resolveChatParamsForRole({
    role: "notes",
    model: "gpt-5.6-sol",
    config: {
      ...baseConfig,
      samplingMode: "reasoning",
      reasoningEffort: "max",
    },
  });

  expect(params.temperature).toBeUndefined();
  expect(params.reasoning_effort).toBe("max");
});

test("clamps reasoning effort for gpt-5.2-pro", () => {
  const params = resolveChatParamsForRole({
    role: "liveVoiceGate",
    model: "gpt-5.2-pro",
    config: { ...baseConfig, samplingMode: "reasoning" },
  });

  expect(params.reasoning_effort).toBe("medium");
  expect(params.temperature).toBeUndefined();
});

test("falls back to temperature for non GPT-5 models", () => {
  const params = resolveChatParamsForRole({
    role: "liveVoiceGate",
    model: "gpt-4o-mini",
    config: {
      samplingMode: "reasoning",
      reasoningEffort: "high",
      temperature: 0.3,
      verbosity: "high",
    },
  });

  expect(params.temperature).toBe(0.3);
  expect(params.reasoning_effort).toBeUndefined();
  expect(params.verbosity).toBeUndefined();
});
