import { TRPCError } from "@trpc/server";
import { PublicationArchiveConflict } from "../../types/meetingPublication";
import { updateMeetingArchiveService } from "../../services/meetingHistoryService";
export async function saveMeetingArchive(
  params: Parameters<typeof updateMeetingArchiveService>[0],
) {
  const ok = await updateMeetingArchiveService(params).catch(
    (error: unknown) => {
      if (error instanceof PublicationArchiveConflict)
        throw new TRPCError({ code: "CONFLICT", message: error.message });
      throw error;
    },
  );
  if (!ok)
    throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
  return { ok: true };
}
