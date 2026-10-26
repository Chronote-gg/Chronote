import vm from "node:vm";
import { ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";

export function createCommandRegistrationContext(options: {
  onboardingEnabled: boolean;
}): vm.Context {
  const command = new SlashCommandBuilder()
    .setName("fixture")
    .setDescription("Fixture");
  return vm.createContext({
    SlashCommandBuilder,
    ChannelType,
    REST,
    Routes,
    TOKEN: "fake",
    CLIENT_ID: "bot-1",
    config: {
      server: { onboardingEnabled: options.onboardingEnabled },
      chatTts: { maxChars: 100 },
    },
    TTS_VOICE_CHOICES: [{ name: "Alloy", value: "alloy" }],
    TTS_PREFIX_MODE_CHOICES: [{ name: "Default", value: "default" }],
    MIN_TTS_VOLUME_PERCENT: 0,
    MAX_TTS_VOLUME_PERCENT: 200,
    billingCommand: command,
    dismissAutoRecordCommand: command,
    startMeetingContextCommand: command,
    onboardCommand: new SlashCommandBuilder()
      .setName("onboard")
      .setDescription("Old wizard"),
    console: { log: jest.fn(), error: jest.fn() },
  });
}
