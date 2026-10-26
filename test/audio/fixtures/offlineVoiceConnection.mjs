export function offlineVoiceConnection(VoiceConnection) {
  return new VoiceConnection(
    {
      guildId: "offline",
      channelId: "offline",
      selfDeaf: false,
      selfMute: false,
    },
    { adapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }) },
  );
}
