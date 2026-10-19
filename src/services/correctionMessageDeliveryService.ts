import type { RuntimeApiOperation } from "./runtimeApiOperationService";
import { updateMeetingNotesMessageMetadataService } from "./meetingHistoryService";

type MessageResult = { messageIds: string[]; strategy: "edited" | "replaced" };
/** Publish correction messages and persist their exact IDs under the same API owner. */
export async function publishCorrectionMessages(input: {
  operation: RuntimeApiOperation;
  guildId: string;
  historyKey: string;
  channelId: string;
  notesVersion: number;
  publish: () => Promise<MessageResult>;
}): Promise<MessageResult> {
  return input.operation.mutate(async () => {
    const result = await input.publish();
    // This receipt belongs to the issued publication, so persist its ACK before cancellation.
    const saved = await updateMeetingNotesMessageMetadataService({
      guildId: input.guildId,
      channelId_timestamp: input.historyKey,
      notesMessageIds: result.messageIds,
      notesChannelId: input.channelId,
      expectedNotesVersion: input.notesVersion,
    });
    if (!saved) throw new Error("Correction message receipt was not persisted");
    return result;
  });
}
