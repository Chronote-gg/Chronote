import type { CSSProperties } from "react";

export type SourceSignalStatus =
  | "checking"
  | "ready"
  | "recording"
  | "silent"
  | "unavailable";

export type SourceSignal = {
  id: string;
  label: string;
  detail: string;
  status: SourceSignalStatus;
  level: number | null;
};

export type RecorderPanelProps = {
  busy: boolean;
  error: string | null;
  isRecording: boolean;
  message: string | null;
  sourceSignals: SourceSignal[];
  startedAt?: string;
  tags: string;
  title: string;
  variant?: "default" | "compact";
  onStartRecording: () => void;
  onStopAndUpload: () => void;
  onTagsChange: (value: string) => void;
  onTitleChange: (value: string) => void;
};

const clampLevel = (level: number | null) => {
  if (level === null || Number.isNaN(level)) return null;
  return Math.min(1, Math.max(0, level));
};

function SourceSignalCard({ source }: { source: SourceSignal }) {
  const level = clampLevel(source.level);
  const levelPercent = level === null ? 0 : Math.round(level * 100);
  const meterStyle = {
    "--source-signal-level": `${levelPercent}%`,
  } as CSSProperties;

  return (
    <article className="source-card">
      <div className="source-card-header">
        <div>
          <strong>{source.label}</strong>
          <span>{source.detail}</span>
        </div>
      </div>
      <div
        aria-label={`${source.label} signal level`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={level === null ? undefined : levelPercent}
        className="source-meter"
        role="meter"
        style={meterStyle}
      >
        <span />
      </div>
    </article>
  );
}

export function RecorderPanel({
  busy,
  error,
  isRecording,
  message,
  sourceSignals,
  startedAt,
  tags,
  title,
  variant = "default",
  onStartRecording,
  onStopAndUpload,
  onTagsChange,
  onTitleChange,
}: RecorderPanelProps) {
  return (
    <div className={`panel recorder-panel recorder-panel-${variant}`}>
      <div>
        <h1>Recorder</h1>
      </div>
      <div className="record-action-row">
        {!isRecording ? (
          <button
            type="button"
            className="record-button"
            onClick={onStartRecording}
            disabled={busy}
          >
            Record
          </button>
        ) : (
          <button
            type="button"
            className="record-button recording"
            onClick={onStopAndUpload}
            disabled={busy}
          >
            Stop and upload
          </button>
        )}
        {isRecording || startedAt ? (
          <div className="record-meta">
            {isRecording ? <strong>Recording in progress</strong> : null}
            {startedAt ? <span>Started {startedAt}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="source-grid" aria-label="Audio source status">
        {sourceSignals.map((source) => (
          <SourceSignalCard key={source.id} source={source} />
        ))}
      </div>
      <div className="details-grid">
        <label>
          Title
          <input
            value={title}
            onChange={(event) => onTitleChange(event.currentTarget.value)}
            placeholder="Optional"
            disabled={busy || isRecording}
          />
        </label>
        <label>
          Tags
          <input
            value={tags}
            onChange={(event) => onTagsChange(event.currentTarget.value)}
            placeholder="planning, research"
            disabled={busy || isRecording}
          />
        </label>
      </div>
      {message ? <p className="message">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
