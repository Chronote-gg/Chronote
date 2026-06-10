import {
  buildTtsSpeechText,
  normalizeChatTtsSpeakerPrefixMode,
  normalizeUserChatTtsSpeakerPrefixMode,
  resolveChatTtsSpeakerPrefixMode,
} from "../ttsText";

describe("ttsText", () => {
  it("prefixes automatic chat when using the default chat-only mode", () => {
    expect(
      buildTtsSpeechText({
        message: "hello",
        speakerName: "Alex",
        prefixMode: "chat_only",
        context: "chat",
      }),
    ).toBe("Alex said hello");
  });

  it("does not prefix /say in chat-only mode", () => {
    expect(
      buildTtsSpeechText({
        message: "hello",
        speakerName: "Alex",
        prefixMode: "chat_only",
        context: "say",
      }),
    ).toBe("hello");
  });

  it("supports explicit always and never modes", () => {
    expect(
      buildTtsSpeechText({
        message: "hello",
        speakerName: "Alex",
        prefixMode: "always",
        context: "say",
      }),
    ).toBe("Alex said hello");
    expect(
      buildTtsSpeechText({
        message: "hello",
        speakerName: "Alex",
        prefixMode: "never",
        context: "chat",
      }),
    ).toBe("hello");
  });

  it("normalizes server and player prefix modes", () => {
    expect(normalizeChatTtsSpeakerPrefixMode("CHAT_ONLY")).toBe("chat_only");
    expect(normalizeChatTtsSpeakerPrefixMode("default")).toBeUndefined();
    expect(normalizeUserChatTtsSpeakerPrefixMode("default")).toBe("default");
  });

  it("resolves player mode before server default", () => {
    expect(resolveChatTtsSpeakerPrefixMode("always", "never")).toBe("always");
    expect(resolveChatTtsSpeakerPrefixMode(undefined, "never")).toBe("never");
    expect(resolveChatTtsSpeakerPrefixMode("default", "always")).toBe("always");
  });
});
