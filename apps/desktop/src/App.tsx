import { useEffect, useState } from "react";

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

type UploadJob = {
  uploadId: string;
  status: "pending_upload" | "queued" | "processing" | "complete" | "failed";
  errorMessage?: string;
  meetingGuildId?: string;
  channelId_timestamp?: string;
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
const STATUS_POLL_MS = 5000;

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

const isBlockingJob = (job?: UploadJob | null) =>
  job?.status === "queued" || job?.status === "processing";

function openMeetingUrl(portalBaseUrl: string, job: UploadJob) {
  if (!job.meetingGuildId || !job.channelId_timestamp) return undefined;
  const base = portalBaseUrl.replace(/\/$/, "");
  return `${base}/portal/meetings/${encodeURIComponent(
    job.meetingGuildId,
  )}/${encodeURIComponent(job.channelId_timestamp)}`;
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [portalBaseUrl, setPortalBaseUrl] = useState(DEFAULT_PORTAL_BASE_URL);
  const [user, setUser] = useState<DesktopUser | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
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

  useEffect(() => {
    void invoke<DesktopUser | null>("get_session")
      .then(setUser)
      .catch(() => undefined);
    void invoke<RecordingStatus>("get_recording_status")
      .then(setRecording)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void invoke<AudioDevice[]>("list_audio_devices")
      .then(setDevices)
      .catch((err: unknown) => {
        setError(formatError(err, "Failed to load devices."));
      });
  }, []);

  useEffect(() => {
    if (!job || job.status === "complete" || job.status === "failed") return;
    const timer = window.setInterval(() => {
      void invoke<{ job: UploadJob }>("get_upload_status", {
        apiBaseUrl,
        uploadId: job.uploadId,
      })
        .then((result) => setJob(result.job))
        .catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, job]);

  async function login() {
    setBusy(true);
    setError(null);
    setMessage("Opening browser sign-in...");
    try {
      const nextUser = await invoke<DesktopUser>("login", { apiBaseUrl });
      setUser(nextUser);
      setMessage("Signed in to Chronote.");
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
      setMessage("Upload received. Chronote is processing your meeting.");
    } catch (err) {
      setError(formatError(err, "Upload failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <strong className="brand">Chronote</strong>
          <span className="status-text">{statusLabel}</span>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setShowSettings((value) => !value)}
          disabled={busy || recording.isRecording}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
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
            <div className="panel recorder-panel">
              <div>
                <h1>Recorder</h1>
                <p className="lede">
                  Mic is labeled Me. Computer audio is labeled System/Other.
                </p>
              </div>
              <div className="record-action-row">
                {!recording.isRecording ? (
                  <button
                    type="button"
                    className="record-button"
                    onClick={startRecording}
                    disabled={busy}
                  >
                    Record
                  </button>
                ) : (
                  <button
                    type="button"
                    className="record-button recording"
                    onClick={stopAndUpload}
                    disabled={busy}
                  >
                    Stop and upload
                  </button>
                )}
                <div className="record-meta">
                  <strong>
                    {recording.isRecording
                      ? "Recording in progress"
                      : "Ready for a new personal meeting"}
                  </strong>
                  {recording.startedAt ? (
                    <span>Started {recording.startedAt}</span>
                  ) : null}
                </div>
              </div>
              <div className="details-grid">
                <label>
                  Title
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    placeholder="Optional"
                    disabled={busy || recording.isRecording}
                  />
                </label>
                <label>
                  Tags
                  <input
                    value={tags}
                    onChange={(event) => setTags(event.currentTarget.value)}
                    placeholder="planning, research"
                    disabled={busy || recording.isRecording}
                  />
                </label>
              </div>
              {message ? <p className="message">{message}</p> : null}
              {error ? <p className="error">{error}</p> : null}
            </div>

            <aside className="panel side-panel">
              <h2>Recent</h2>
              {job ? (
                <>
                  <p>
                    Upload status: <strong>{job.status}</strong>
                  </p>
                  {job.errorMessage ? (
                    <p className="error">{job.errorMessage}</p>
                  ) : null}
                  {meetingUrl ? (
                    <a
                      className="meeting-link"
                      href={meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open meeting in Chronote
                    </a>
                  ) : null}
                  {isBlockingJob(job) ? (
                    <p className="message">Checking status...</p>
                  ) : null}
                </>
              ) : (
                <p>No desktop uploads in this session yet.</p>
              )}
              <a
                className="meeting-link"
                href={portalBaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Chronote
              </a>
            </aside>
          </section>
          <footer className="account-row">
            <span>Signed in as {user.username}</span>
            <button
              type="button"
              className="secondary-button"
              onClick={logout}
              disabled={busy || recording.isRecording}
            >
              Sign out
            </button>
          </footer>
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
