import "./RetainedRecordingCard.css";

type RetainedRecordingSource = {
  sourceId: string;
  kind: string;
  label: string;
  fileSize: number;
  segmentCount: number;
  uploadedSegmentCount: number;
};

export type RetainedRecording = {
  recordingId: string;
  startedAt: string;
  stoppedAt: string;
  retainedAt: string;
  title?: string | null;
  tags: string[];
  status: string;
  errorMessage?: string | null;
  localPath: string;
  sources: RetainedRecordingSource[];
};

export type RetainedRecordingAction = {
  recordingId: string;
  action: "retry" | "open" | "delete";
};

function formatRetainedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function RetainedRecordingCard({
  retained,
  runningAction,
  busy,
  isRecording,
  onRetry,
  onOpen,
  onDelete,
}: {
  retained: RetainedRecording;
  runningAction: RetainedRecordingAction["action"] | null;
  busy: boolean;
  isRecording: boolean;
  onRetry: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
  onDelete: (recordingId: string) => void;
}) {
  const retryable = retained.status === "failed_upload";
  return (
    <article className="retained-recording-card">
      <strong>{retained.title || "Untitled recording"}</strong>
      <span>Saved {formatRetainedDate(retained.retainedAt)}</span>
      {retained.status === "paused" ? (
        <p className="message">
          {retained.errorMessage ??
            "This draft is preserved and paused. Recovery is not available yet."}
        </p>
      ) : retained.errorMessage ? (
        <p className="error">{retained.errorMessage}</p>
      ) : null}
      <p>
        {retained.sources
          .map(
            (source) =>
              `${source.label}: ${source.uploadedSegmentCount}/${source.segmentCount} segments, ${formatBytes(source.fileSize)}`,
          )
          .join(" | ")}
      </p>
      <code>{retained.localPath}</code>
      <div className="retained-actions">
        <button
          type="button"
          className="retry-upload"
          onClick={() => onRetry(retained.recordingId)}
          disabled={busy || isRecording || runningAction !== null || !retryable}
        >
          {runningAction === "retry"
            ? "Retrying..."
            : retryable || retained.status === "paused"
              ? "Retry upload"
              : "Not retryable"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onOpen(retained.recordingId)}
          disabled={runningAction !== null}
        >
          {runningAction === "open" ? "Opening..." : "Open folder"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onDelete(retained.recordingId)}
          disabled={busy || isRecording || runningAction !== null}
        >
          {runningAction === "delete" ? "Deleting..." : "Delete"}
        </button>
      </div>
    </article>
  );
}
