import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { getGlobalConfigValues } from "../../src/services/appConfigService";
import { getConfigOverridesRepository } from "../../src/repositories/configOverridesRepository";

jest.mock("../../src/services/appConfigService", () => ({
  getGlobalConfigValues: jest.fn(async () => ({})),
}));

const resolve = () =>
  resolveMeetingRuntimeConfig({
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
  });

beforeEach(() => {
  resetMockStore();
  jest.mocked(getGlobalConfigValues).mockResolvedValue({});
});

it("defaultsSpeechDetectionOff", async () => {
  const resolved = await resolve();
  expect(resolved.transcription).toHaveProperty("speechDetectionMode", "off");
});

it("captures the mode for a meeting while newly resolved meetings see global changes", async () => {
  jest
    .mocked(getGlobalConfigValues)
    .mockResolvedValue({ "transcription.speechDetection.mode": "shadow" });
  const activeMeeting = await resolve();
  jest
    .mocked(getGlobalConfigValues)
    .mockResolvedValue({ "transcription.speechDetection.mode": "enforce" });
  const newMeeting = await resolve();
  expect(activeMeeting.transcription).toHaveProperty(
    "speechDetectionMode",
    "shadow",
  );
  expect(newMeeting.transcription).toHaveProperty(
    "speechDetectionMode",
    "enforce",
  );
});

it("ignores stored global and server values for settings that were removed", async () => {
  const removed = {
    "transcription.language": "fr",
    "transcription.promptEcho.enabled": true,
    "transcription.vote.enabled": true,
    "transcription.finalPass.enabled": true,
    "models.transcriptionCoalesce": "gpt-5-mini",
  };
  jest.mocked(getGlobalConfigValues).mockResolvedValue(removed);
  for (const [configKey, value] of Object.entries(removed))
    await getConfigOverridesRepository().write({
      scopeId: "server#guild-1",
      configKey,
      value,
      updatedAt: "2026-11-01T00:00:00.000Z",
      updatedBy: "admin",
    });
  const resolved = await resolve();
  for (const key of [
    "language",
    "promptEchoEnabled",
    "voteEnabled",
    "finalPassEnabled",
  ])
    expect(resolved.transcription).not.toHaveProperty(key);
  expect(resolved.modelChoices).not.toHaveProperty("transcriptionCoalesce");
  expect(resolved.modelChoices?.transcription).toBe("gpt-transcribe");
});
