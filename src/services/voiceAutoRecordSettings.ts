import { getAutoRecordSettingByChannel } from "./autorecordService";
import { getChronoteDemo } from "./chronoteDemo";

export async function resolveVoiceAutoRecord(
  guildId: string,
  voiceChannelId: string,
) {
  const demo = await getChronoteDemo();
  if (demo?.guildId === guildId && demo.voiceChannelId === voiceChannelId) {
    return {
      setting: {
        enabled: true,
        recordAll: false,
        channelId: voiceChannelId,
        tags: undefined,
      },
      demoOutputChannelId: demo.outputChannelId,
    };
  }

  const channel = await getAutoRecordSettingByChannel(guildId, voiceChannelId);
  return {
    setting: channel ?? (await getAutoRecordSettingByChannel(guildId, "ALL")),
  };
}
