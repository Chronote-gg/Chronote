import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { trpc } from "../services/trpc";
import type { MeetingBrowseSearch } from "../utils/meetingBrowseSearch";
import { useMeetingBrowse } from "../pages/hooks/useMeetingBrowse";
import { useGuildContext } from "./GuildContext";
import type { MeetingSource } from "../components/MeetingSources";
const MeetingBrowseContext = createContext<
  (ReturnType<typeof useMeetingBrowse> & { sources: MeetingSource[] }) | null
>(null);
export function MeetingBrowseProvider({
  children,
  search,
  enabled,
}: {
  children: ReactNode;
  search: MeetingBrowseSearch;
  enabled: boolean;
}) {
  const { guilds } = useGuildContext();
  const membershipKey = JSON.stringify(
    [...new Set(guilds.map((guild) => guild.id))].sort(),
  );
  const [membership, setMembership] = useState({
    key: membershipKey,
    ready: true,
  });
  if (membership.key !== membershipKey)
    setMembership({ key: membershipKey, ready: false });
  const membershipReady = membership.key === membershipKey && membership.ready;
  const utils = trpc.useUtils();
  const browse = useMeetingBrowse(search, enabled && membershipReady);
  useEffect(() => {
    if (membershipReady) return;
    let current = true;
    void utils.meetings.myList.reset().then(() => {
      if (current) setMembership({ key: membershipKey, ready: true });
    });
    return () => {
      current = false;
    };
  }, [membershipKey, membershipReady, utils]);
  const [retained, setRetained] = useState<{
    membershipKey: string;
    sources: MeetingSource[];
  }>({
    membershipKey,
    sources: [],
  });
  const retainedSources =
    retained.membershipKey === membershipKey ? retained.sources : [];
  useEffect(() => {
    setRetained((previous) => {
      const next =
        previous.membershipKey === membershipKey ? [...previous.sources] : [];
      for (const row of browse.rows) {
        if (
          row.serverId &&
          !row.serverId.startsWith("personal:") &&
          !guilds.some((guild) => guild.id === row.serverId) &&
          !next.some((source) => source.id === row.serverId)
        )
          next.push({
            id: row.serverId,
            name: row.serverName || "Previous server",
            retainedAccess: true,
          });
      }
      return previous.membershipKey === membershipKey &&
        next.length === previous.sources.length
        ? previous
        : { membershipKey, sources: next };
    });
  }, [browse.rows, guilds, membershipKey]);
  const sources: MeetingSource[] = [
    ...guilds,
    ...retainedSources.filter(
      (source) => !guilds.some((guild) => guild.id === source.id),
    ),
  ];
  for (const row of browse.rows) {
    if (
      row.serverId &&
      !row.serverId.startsWith("personal:") &&
      !sources.some((source) => source.id === row.serverId)
    )
      sources.push({
        id: row.serverId,
        name: row.serverName || "Previous server",
        retainedAccess: true,
      });
  }
  return (
    <MeetingBrowseContext.Provider
      value={{
        ...browse,
        isLoading: !membershipReady || browse.isLoading,
        sources,
      }}
    >
      {children}
    </MeetingBrowseContext.Provider>
  );
}
export function useMeetingBrowseContext() {
  const context = useContext(MeetingBrowseContext);
  if (!context) throw new Error("Meetings requires MeetingBrowseProvider");
  return context;
}
export function useOptionalMeetingBrowseContext() {
  return useContext(MeetingBrowseContext);
}
