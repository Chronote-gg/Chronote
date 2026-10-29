import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
  const browse = useMeetingBrowse(search, enabled);
  const { guilds } = useGuildContext();
  const [retainedSources, setRetainedSources] = useState<MeetingSource[]>([]);
  useEffect(() => {
    setRetainedSources((previous) => {
      const next = [...previous];
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
      return next.length === previous.length ? previous : next;
    });
  }, [browse.rows, guilds]);
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
    <MeetingBrowseContext.Provider value={{ ...browse, sources }}>
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
