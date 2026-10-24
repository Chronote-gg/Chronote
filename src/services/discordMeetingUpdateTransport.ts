import {
  createDiscordMessageEditor,
  createDiscordMessageTransport,
  discordEditorMessageSchema,
} from "./discordMessageEditor";
export function createDiscordMeetingUpdateTransport(
  options: Parameters<typeof createDiscordMessageEditor>[0],
) {
  const transport = createDiscordMessageTransport(options);
  const editor = createDiscordMessageEditor(options);
  return {
    getBotIdentity: editor.getBotIdentity,
    getChannel: editor.getChannel,
    getMessage: editor.getMessage,
    writeNotesMessage: async (
      input: Parameters<typeof transport.writeNotesMessage>[0],
    ) =>
      discordEditorMessageSchema.parse(
        await transport.writeNotesMessage(input),
      ),
    deleteNotesMessage: transport.deleteNotesMessage,
  };
}
