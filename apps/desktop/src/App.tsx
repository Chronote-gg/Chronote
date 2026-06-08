import { type MouseEvent, useEffect, useState } from "react";
import { RecorderPanel, type SourceSignal } from "./RecorderPanel";

type DesktopUser = {
  id: string;
  username: string;
  avatar?: string | null;
  scopes: string[];
};

type AudioDevice = {
  id: string;
  name: string;
  direction: "input" | "output";
  isDefaultCommunications: boolean;
};

type RecordingStatus = {
  isRecording: boolean;
  startedAt?: string;
};

type RecordingSourceSignal = {
  sourceId: string;
  kind: string;
  label: string;
  peakLevel: number;
  rmsLevel: number;
  sampleCount: number;
  updatedAtEpochMs: number;
};

type LoginResult = {
  user: DesktopUser;
  sessionPersisted: boolean;
  persistenceWarning?: string;
};

type UploadJob = {
  uploadId: string;
  status: "pending_upload" | "queued" | "processing" | "complete" | "failed";
  errorMessage?: string;
  meetingGuildId?: string;
  channelIdTimestamp?: string;
};

type UploadResult = {
  job: UploadJob;
};

const DEFAULT_API_BASE_URL =
  import.meta.env.VITE_DESKTOP_API_BASE_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:3001" : "https://api.chronote.gg");
const DEFAULT_PORTAL_BASE_URL =
  import.meta.env.VITE_DESKTOP_PORTAL_BASE_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:5173" : "https://chronote.gg");
const SIGNAL_STALE_MS = 2000;
const SILENCE_RMS_THRESHOLD = 0.01;
const UPLOAD_STATUS_POLL_MS = 2000;
const RECORDING_SIGNAL_EVENT = "recording-source-signal";

const invoke = <T,>(command: string, args?: Record<string, unknown>) => {
  const tauriInvoke = window.__TAURI__?.core.invoke;
  if (!tauriInvoke) {
    return Promise.reject(
      new Error("Chronote Desktop is not running inside Tauri."),
    );
  }
  return tauriInvoke<T>(command, args);
};

const parseTags = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);

const formatError = (err: unknown, fallback: string) => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
};

const isProcessingJob = (job?: UploadJob | null) =>
  job?.status === "pending_upload" ||
  job?.status === "queued" ||
  job?.status === "processing";

const uploadStatusCopy = (job: UploadJob, meetingUrl?: string) => {
  if (job.status === "complete" && meetingUrl) return "Your meeting is ready.";
  if (job.status === "complete") {
    return "Your meeting is ready, but Chronote is still syncing the link.";
  }
  if (job.status === "failed") return "Processing failed.";
  if (meetingUrl) return "Your meeting is processing. You can open it now.";
  return "Processing your meeting. This will update when notes are ready.";
};

function openMeetingUrl(portalBaseUrl: string, job: UploadJob) {
  if (!job.meetingGuildId || !job.channelIdTimestamp) return undefined;
  const base = portalBaseUrl.replace(/\/$/, "");
  return `${base}/portal/meetings/${encodeURIComponent(
    job.meetingGuildId,
  )}/${encodeURIComponent(job.channelIdTimestamp)}`;
}

function openPortalUrl(portalBaseUrl: string) {
  return `${portalBaseUrl.replace(/\/$/, "")}/portal/meetings`;
}

function getDeviceLabel(
  devices: AudioDevice[],
  selectedId: string,
  fallback: string,
) {
  if (!selectedId) return fallback;
  return devices.find((device) => device.id === selectedId)?.name ?? fallback;
}

function buildSourceSignal(
  source: Pick<SourceSignal, "id" | "label">,
  detail: string,
  devicesLoaded: boolean,
  hasDevice: boolean,
  isRecording: boolean,
  signal?: RecordingSourceSignal,
): SourceSignal {
  const level = signal ? Math.max(0, Math.min(1, signal.peakLevel)) : null;
  const stale = signal
    ? Date.now() - signal.updatedAtEpochMs > SIGNAL_STALE_MS
    : false;
  const hasSamples = Boolean(signal && signal.sampleCount > 0);
  const status = !devicesLoaded
    ? "checking"
    : !hasDevice
      ? "unavailable"
      : isRecording && !hasSamples
        ? "checking"
        : isRecording &&
            (stale || (signal?.rmsLevel ?? 0) < SILENCE_RMS_THRESHOLD)
          ? "silent"
          : isRecording
            ? "recording"
            : "ready";

  return {
    ...source,
    detail,
    level,
    status,
  };
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [portalBaseUrl, setPortalBaseUrl] = useState(DEFAULT_PORTAL_BASE_URL);
  const [user, setUser] = useState<DesktopUser | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [recordingSignals, setRecordingSignals] = useState<
    Record<string, RecordingSourceSignal>
  >({});
  const [micDeviceId, setMicDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [recording, setRecording] = useState<RecordingStatus>({
    isRecording: false,
  });
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [job, setJob] = useState<UploadJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputDevices = devices.filter((device) => device.direction === "input");
  const outputDevices = devices.filter(
    (device) => device.direction === "output",
  );
  const meetingUrl = job ? openMeetingUrl(portalBaseUrl, job) : undefined;
  const statusLabel = recording.isRecording
    ? "Recording"
    : user
      ? "Ready"
      : "Signed out";
  const sourceSignals = [
    buildSourceSignal(
      { id: "mic", label: "Mic" },
      getDeviceLabel(
        inputDevices,
        micDeviceId,
        "Default communications microphone",
      ),
      devicesLoaded,
      inputDevices.length > 0,
      recording.isRecording,
      recordingSignals.owner_mic,
    ),
    buildSourceSignal(
      { id: "system", label: "System/Other" },
      getDeviceLabel(
        outputDevices,
        outputDeviceId,
        "Default communications output",
      ),
      devicesLoaded,
      outputDevices.length > 0,
      recording.isRecording,
      recordingSignals.system_output,
    ),
  ];

  useEffect(() => {
    void invoke<DesktopUser | null>("get_session", { apiBaseUrl })
      .then(setUser)
      .catch(() => undefined);
    void invoke<RecordingStatus>("get_recording_status")
      .then(setRecording)
      .catch(() => undefined);
  }, [apiBaseUrl]);

  useEffect(() => {
    void invoke<AudioDevice[]>("list_audio_devices")
      .then((nextDevices) => {
        setDevices(nextDevices);
        setDevicesLoaded(true);
      })
      .catch((err: unknown) => {
        setDevicesLoaded(true);
        setError(formatError(err, "Failed to load devices."));
      });
  }, []);

  useEffect(() => {
    if (
      !job ||
      job.status === "failed" ||
      (job.status === "complete" && meetingUrl)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void invoke<{ job: UploadJob }>("get_upload_status", {
        apiBaseUrl,
        uploadId: job.uploadId,
      })
        .then((result) => setJob(result.job))
        .catch(() => undefined);
    }, UPLOAD_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, job, meetingUrl]);

  useEffect(() => {
    if (!recording.isRecording) {
      setRecordingSignals({});
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void window.__TAURI__?.event
      ?.listen<RecordingSourceSignal>(RECORDING_SIGNAL_EVENT, (event) => {
        if (cancelled) return;
        setRecordingSignals((current) => ({
          ...current,
          [event.payload.sourceId]: event.payload,
        }));
      })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      setRecordingSignals({});
      unlisten?.();
    };
  }, [recording.isRecording]);

  async function login() {
    setBusy(true);
    setError(null);
    setMessage("Opening browser sign-in...");
    try {
      const result = await invoke<LoginResult>("login", { apiBaseUrl });
      setUser(result.user);
      setMessage(
        result.sessionPersisted
          ? "Signed in to Chronote."
          : `Signed in for this session, but Chronote could not save your session: ${
              result.persistenceWarning ?? "credential storage failed"
            }`,
      );
    } catch (err) {
      setError(formatError(err, "Sign-in failed."));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await invoke("logout", { apiBaseUrl });
      setUser(null);
      setMessage("Signed out.");
    } catch (err) {
      setError(formatError(err, "Sign-out failed."));
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setJob(null);
    try {
      const status = await invoke<RecordingStatus>("start_recording", {
        micDeviceId: micDeviceId || null,
        outputDeviceId: outputDeviceId || null,
      });
      setRecording(status);
      setMessage("Recording started.");
    } catch (err) {
      setError(formatError(err, "Recording failed to start."));
    } finally {
      setBusy(false);
    }
  }

  async function stopAndUpload() {
    setBusy(true);
    setError(null);
    setMessage("Stopping and uploading recording...");
    try {
      const result = await invoke<UploadResult>("stop_and_upload_recording", {
        apiBaseUrl,
        title: title.trim() || null,
        tags: parseTags(tags),
      });
      setJob(result.job);
      setRecording({ isRecording: false });
      setMessage("Upload received.");
    } catch (err) {
      setError(formatError(err, "Upload failed."));
    } finally {
      setBusy(false);
    }
  }

  async function openExternalUrl(
    event: MouseEvent<HTMLAnchorElement>,
    url: string,
  ) {
    event.preventDefault();
    setError(null);
    try {
      await invoke("open_external_url", { url });
    } catch (err) {
      setError(formatError(err, "Failed to open Chronote."));
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <strong className="brand">Chronote</strong>
          <span className="status-text">{statusLabel}</span>
        </div>
        <div className="top-actions">
          {user ? (
            <span className="account-label">Signed in as {user.username}</span>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={() => setShowSettings((value) => !value)}
            disabled={busy || recording.isRecording}
          >
            {showSettings ? "Hide settings" : "Settings"}
          </button>
          {user ? (
            <button
              type="button"
              className="secondary-button"
              onClick={logout}
              disabled={busy || recording.isRecording}
            >
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {!user ? (
        <section className="panel auth-panel">
          <h1>Sign in to record</h1>
          <p>
            Chronote Desktop records your microphone and computer audio, then
            uploads the result as a personal meeting.
          </p>
          <button type="button" onClick={login} disabled={busy}>
            Sign in with Chronote
          </button>
          {message ? <p className="message">{message}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </section>
      ) : (
        <>
          <section className="record-layout">
            <RecorderPanel
              busy={busy}
              error={error}
              isRecording={recording.isRecording}
              message={message}
              sourceSignals={sourceSignals}
              startedAt={recording.startedAt}
              tags={tags}
              title={title}
              onStartRecording={startRecording}
              onStopAndUpload={stopAndUpload}
              onTagsChange={setTags}
              onTitleChange={setTitle}
            />

            <aside className="panel side-panel">
              <h2>Recent</h2>
              {job ? (
                <>
                  <p>{uploadStatusCopy(job, meetingUrl)}</p>
                  {job.errorMessage ? (
                    <p className="error">{job.errorMessage}</p>
                  ) : null}
                  {meetingUrl ? (
                    <a
                      className="meeting-link"
                      href={meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => openExternalUrl(event, meetingUrl)}
                    >
                      Open created meeting
                    </a>
                  ) : null}
                  {isProcessingJob(job) && !meetingUrl ? (
                    <p className="message">Checking processing status...</p>
                  ) : null}
                  {job.status === "complete" && !meetingUrl ? (
                    <p className="message">Checking status again...</p>
                  ) : null}
                </>
              ) : (
                <>
                  <p>No desktop uploads in this session yet.</p>
                  <a
                    className="meeting-link"
                    href={openPortalUrl(portalBaseUrl)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) =>
                      openExternalUrl(event, openPortalUrl(portalBaseUrl))
                    }
                  >
                    Open Chronote meetings
                  </a>
                </>
              )}
            </aside>
          </section>
        </>
      )}

      {showSettings ? (
        <section className="panel settings-panel">
          <h2>Audio Sources</h2>
          <div className="settings-grid">
            <label>
              Microphone
              <select
                value={micDeviceId}
                onChange={(event) => setMicDeviceId(event.currentTarget.value)}
                disabled={busy || recording.isRecording}
              >
                <option value="">Default communications microphone</option>
                {inputDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                    {device.isDefaultCommunications ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              System output
              <select
                value={outputDeviceId}
                onChange={(event) =>
                  setOutputDeviceId(event.currentTarget.value)
                }
                disabled={busy || recording.isRecording}
              >
                <option value="">Default communications output</option>
                {outputDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                    {device.isDefaultCommunications ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API base URL
              <input
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.currentTarget.value)}
                disabled={busy || recording.isRecording}
              />
            </label>
            <label>
              Portal base URL
              <input
                value={portalBaseUrl}
                onChange={(event) =>
                  setPortalBaseUrl(event.currentTarget.value)
                }
                disabled={busy}
              />
            </label>
          </div>
        </section>
      ) : null}
    </main>
  );
}
