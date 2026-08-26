import { MODEL_SELECTION_DEFAULTS } from "../../src/config/modelChoices";
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
    expect(resolved.notes).toBe("gpt-5.6-sol");
    expect(resolved.ask).toBe("gpt-5.6-terra");
    expect(resolved.liveVoiceGate).toBe("gpt-5.6-luna");
    expect(resolved.imageCaption).toBe("gpt-5.6-luna");
  });
});
