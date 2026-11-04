import { useState } from "react";
import { IconCalendarEvent, IconUser } from "@tabler/icons-react";
import type { MeetingBrowseScope } from "../../types/meetingBrowse";
import classes from "./MeetingSources.module.css";
export type MeetingSource = {
  id: string;
  name: string;
  icon?: string | null;
  retainedAccess?: boolean;
};
export type MeetingSourcesProps = {
  sources: MeetingSource[];
  scope: MeetingBrowseScope;
  onSelect: (scope: MeetingBrowseScope) => void;
};
function SourceIcon({ source }: { source: MeetingSource }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const icon = source.icon;
  return (
    <span className={classes.icon}>
      {icon && failedIcon !== icon ? (
        <img
          alt=""
          role="img"
          src={`https://cdn.discordapp.com/icons/${source.id}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}?size=128`}
          onError={() => setFailedIcon(icon)}
        />
      ) : (
        source.name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((word) => word[0])
          .join("")
          .toUpperCase()
      )}
    </span>
  );
}
export default function MeetingSources({
  sources,
  scope,
  onSelect,
}: MeetingSourcesProps) {
  return (
    <section
      className={classes.container}
      aria-label="Meeting sources"
      tabIndex={0}
    >
      <div className={classes.grid}>
        <button
          type="button"
          className={classes.source}
          aria-pressed={scope.kind === "all"}
          onClick={() => onSelect({ kind: "all" })}
        >
          <span className={classes.icon}>
            <IconCalendarEvent size={20} />
          </span>
          <span>All meetings</span>
        </button>
        <button
          type="button"
          className={classes.source}
          aria-pressed={scope.kind === "personal"}
          onClick={() => onSelect({ kind: "personal" })}
        >
          <span className={classes.icon}>
            <IconUser size={20} />
          </span>
          <span>Personal recordings</span>
        </button>
        {sources.map((source) => (
          <button
            type="button"
            key={source.id}
            className={classes.source}
            aria-pressed={
              scope.kind === "guild" && scope.serverId === source.id
            }
            onClick={() => onSelect({ kind: "guild", serverId: source.id })}
          >
            <SourceIcon source={source} />
            <span className={classes.name} title={source.name}>
              {source.name}
              {source.retainedAccess ? <small>Previous server</small> : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
