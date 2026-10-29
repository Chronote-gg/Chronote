import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { getGlobalConfigValues } from "../../src/services/appConfigService";

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

it("defaults the transcription language to English", async () => {
  const resolved = await resolve();
  expect(resolved.transcription).toHaveProperty("language", "en");
});

it("captures auto transcription language from global config", async () => {
  jest
    .mocked(getGlobalConfigValues)
    .mockResolvedValue({ "transcription.language": "auto" });
  const resolved = await resolve();
  expect(resolved.transcription).toHaveProperty("language", "auto");
});
