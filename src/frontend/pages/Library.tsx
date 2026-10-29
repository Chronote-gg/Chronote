import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { legacyLibrarySearch } from "../utils/meetingBrowseSearch";

export default function Library() {
  const { serverId } = useParams({ from: "/portal/server/$serverId/library" });
  const search = useSearch({ strict: false });
  return (
    <Navigate
      to="/portal/meetings"
      search={legacyLibrarySearch(serverId, search)}
      replace
    />
  );
}
export type { MeetingListItem } from "./library/types";
