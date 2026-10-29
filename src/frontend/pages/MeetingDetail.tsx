import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { meetingBrowseSearchSchema } from "../utils/meetingBrowseSearch";
export default function MeetingDetail() {
  const { serverId, meetingId } = useParams({
    from: "/portal/meetings/$serverId/$meetingId",
  });
  const search = useSearch({ from: "/portal/meetings/$serverId/$meetingId" });
  return (
    <Navigate
      to="/portal/meetings"
      replace
      search={meetingBrowseSearchSchema.parse({
        ...search,
        meetingServerId: serverId,
        meetingId,
      })}
    />
  );
}
