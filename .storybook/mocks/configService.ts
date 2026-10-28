// The shared registry reads these server defaults through modelChoices.
// Storybook must not load dotenv, credentials, or server configuration in a browser.
type ServerConfig = typeof import("../../src/services/configService").config;
export const config = {
  notes: { model: "gpt-5.2" },
  liveVoice: {
    gateModel: "gpt-5-mini",
    responderModel: "gpt-4o-mini",
    ttsModel: "gpt-4o-mini-tts",
  },
} satisfies {
  notes: Pick<ServerConfig["notes"], "model">;
  liveVoice: Pick<
    ServerConfig["liveVoice"],
    "gateModel" | "responderModel" | "ttsModel"
  >;
};
