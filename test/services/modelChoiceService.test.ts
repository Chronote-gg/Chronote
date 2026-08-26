import {
  MODEL_SELECTION_DEFAULTS,
  MODEL_SELECTION_OPTIONS,
  buildModelSelectionKey,
} from "../../src/config/modelChoices";
import { resolveModelChoicesByRole } from "../../src/services/modelChoiceService";

describe("modelChoiceService", () => {
  test("resolves defaults when snapshot values are missing", () => {
    const snapshot = {
      values: {},
      experimentalEnabled: false,
      missingRequired: [],
    };
    const resolved = resolveModelChoicesByRole(snapshot);
    expect(resolved.notes).toBe(MODEL_SELECTION_DEFAULTS.notes);
    expect(resolved.transcription).toBe(MODEL_SELECTION_DEFAULTS.transcription);
    expect(resolved.notes).toBe("gpt-5.2");
    expect(resolved.ask).toBe("gpt-4o-mini");
    expect(resolved.liveVoiceGate).toBe("gpt-5-mini");
    expect(resolved.imageCaption).toBe("gpt-4o-mini");
  });

  test("offers each GPT-5.6 target on its rollout roles", () => {
    expect(MODEL_SELECTION_OPTIONS.notes).toContain("gpt-5.6-sol");
    expect(MODEL_SELECTION_OPTIONS.ask).toContain("gpt-5.6-terra");
    expect(MODEL_SELECTION_OPTIONS.liveVoiceGate).toContain("gpt-5.6-luna");
    expect(MODEL_SELECTION_OPTIONS.imageCaption).toContain("gpt-5.6-luna");
  });

  test("resolves explicit GPT-5.6 rollout overrides", () => {
    const values = {
      notes: "gpt-5.6-sol",
      ask: "gpt-5.6-terra",
      liveVoiceGate: "gpt-5.6-luna",
      imageCaption: "gpt-5.6-luna",
    } as const;
    const snapshot = {
      values: Object.fromEntries(
        Object.entries(values).map(([role, value]) => {
          const key = buildModelSelectionKey(role as keyof typeof values);
          return [key, { key, value, source: "appconfig" as const }];
        }),
      ),
      experimentalEnabled: false,
      missingRequired: [],
    };

    expect(resolveModelChoicesByRole(snapshot)).toMatchObject(values);
  });
});
