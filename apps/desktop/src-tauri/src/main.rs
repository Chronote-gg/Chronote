#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod audio;

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use audio::{AudioDevice, CaptureDirection, CaptureHandle, CaptureSegment, CaptureSignalLevel};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, TimeZone, Utc};
use directories::ProjectDirs;
use rand::{rngs::OsRng, RngCore};
use reqwest::multipart::{Form, Part};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, State};
use tokio::sync::mpsc as async_mpsc;
use url::Url;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "Chronote Desktop";
const KEYRING_ACCOUNT: &str = "chronote-desktop-session";
const TOKEN_REFRESH_SKEW_SECONDS: u64 = 60;
const LOGIN_TIMEOUT_SECONDS: u64 = 300;
const DESKTOP_SCOPES: &str = "profile:read personal_uploads:write meetings:read";
const RECORDING_SOURCE_SIGNAL_EVENT: &str = "recording-source-signal";
const WAV_HEADER_BYTES: u64 = 44;
const RETAINED_RECORDING_MANIFEST_FILE: &str = "recording.json";
const RETAINED_RECORDING_MANIFEST_VERSION: u32 = 2;
const RECORDING_SEGMENT_SECONDS: u64 = 60;
const RETAINED_RECORDING_STATUS_FAILED_UPLOAD: &str = "failed_upload";
const RETAINED_RECORDING_STATUS_UPLOADED_CLEANUP_FAILED: &str = "uploaded_cleanup_failed";
const RETAINED_RECORDING_STATUS_RECORDING: &str = "recording";
const RETAINED_RECORDING_STATUS_PENDING_UPLOAD: &str = "pending_upload";
const RECORDING_SEGMENT_STATUS_SEALED: &str = "sealed";
const RECORDING_SEGMENT_STATUS_UPLOADING: &str = "uploading";
const RECORDING_SEGMENT_STATUS_UPLOADED: &str = "uploaded";
const RECORDING_SEGMENT_STATUS_SUBMITTED: &str = "submitted";
const RECORDING_SEGMENT_STATUS_FAILED: &str = "failed";

#[derive(Default)]
struct AppState {
    session: Mutex<Option<DesktopSession>>,
    recording: Mutex<Option<ActiveRecording>>,
}

struct ActiveRecording {
    started_at: String,
    directory: PathBuf,
    manifest: SharedRecordingManifest,
    segment_tx: async_mpsc::UnboundedSender<SealedSegmentEvent>,
    upload_task: tauri::async_runtime::JoinHandle<()>,
    sources: Vec<RecordingSourceHandle>,
}

struct RecordingSourceHandle {
    capture: CaptureHandle,
    signal_relay: JoinHandle<()>,
    segment_relay: JoinHandle<()>,
}

type SharedRecordingManifest = Arc<Mutex<RetainedRecordingManifest>>;

#[derive(Clone)]
struct RecordingSourceDefinition {
    source_id: String,
    kind: String,
    label: String,
}

#[derive(Clone)]
struct SealedSegmentEvent {
    source_id: String,
    path: PathBuf,
    segment: CaptureSegment,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUser {
    id: String,
    username: String,
    avatar: Option<String>,
    scopes: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSession {
    #[serde(default)]
    api_base_url: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    user: DesktopUser,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
    scope: String,
    user: TokenUser,
}

#[derive(Deserialize)]
struct TokenUser {
    id: String,
    username: String,
    avatar: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStatus {
    is_recording: bool,
    started_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSourceSignal {
    source_id: String,
    kind: String,
    label: String,
    peak_level: f32,
    rms_level: f32,
    sample_count: u64,
    updated_at_epoch_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResult {
    user: DesktopUser,
    session_persisted: bool,
    persistence_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResult {
    job: UploadJob,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadJob {
    upload_id: String,
    status: String,
    error_message: Option<String>,
    meeting_guild_id: Option<String>,
    #[serde(rename = "channelIdTimestamp", alias = "channelId_timestamp")]
    channel_id_timestamp: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSessionResponse {
    upload_id: String,
}

#[derive(Deserialize)]
struct SignedUploadPost {
    url: String,
    fields: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSessionRequest {
    sources: Vec<RecordingSessionSourceRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSessionSourceRequest {
    source_id: String,
    kind: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegmentIntentRequest {
    upload_id: String,
    source_id: String,
    sequence: u32,
    content_type: String,
    file_size: u64,
    checksum_sha256: String,
    duration_millis: u64,
    started_at: String,
    ended_at: String,
    original_file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegmentIntentResponse {
    segment: RecordingSegmentResponse,
    upload_required: bool,
    upload_token: Option<String>,
    upload: Option<SignedUploadPost>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegmentResponse {
    source_s3_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegmentCompleteRequest {
    upload_id: String,
    source_id: String,
    sequence: u32,
    key: String,
    upload_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegmentCompleteResponse {
    segment: RecordingSegmentResponse,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSubmitRequest {
    upload_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadJobResponse {
    job: UploadJob,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRecordingSource {
    source_id: String,
    kind: String,
    label: String,
    file_size: u64,
    segment_count: usize,
    uploaded_segment_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRecordingSegment {
    source_id: String,
    sequence: u32,
    content_type: String,
    file_name: String,
    file_size: u64,
    checksum_sha256: String,
    duration_millis: u64,
    started_at: String,
    ended_at: String,
    status: String,
    source_s3_key: Option<String>,
    error_message: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRecordingSourceManifest {
    source_id: String,
    kind: String,
    label: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRecordingManifest {
    version: u32,
    recording_id: String,
    started_at: String,
    stopped_at: String,
    retained_at: String,
    title: Option<String>,
    tags: Vec<String>,
    upload_id: Option<String>,
    status: String,
    error_message: Option<String>,
    sources: Vec<RetainedRecordingSourceManifest>,
    segments: Vec<RetainedRecordingSegment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRecording {
    recording_id: String,
    started_at: String,
    stopped_at: String,
    retained_at: String,
    title: Option<String>,
    tags: Vec<String>,
    status: String,
    error_message: Option<String>,
    local_path: String,
    sources: Vec<RetainedRecordingSource>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: Option<String>,
    message: Option<String>,
    error_description: Option<String>,
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    grant_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    redirect_uri: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code_verifier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<&'a str>,
}

#[derive(Serialize)]
struct RevokeRequest<'a> {
    token: &'a str,
}

struct SegmentUploadFile {
    source_id: String,
    sequence: u32,
    path: PathBuf,
    file_size: u64,
    checksum_sha256: String,
    duration_millis: u64,
    started_at: String,
    ended_at: String,
    content_type: String,
    file_name: String,
}

#[tauri::command]
fn get_session(
    api_base_url: String,
    state: State<'_, AppState>,
) -> Result<Option<DesktopUser>, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let session = get_cached_or_stored_session(&api_base_url, &state)?;
    Ok(session.map(|session| session.user))
}

#[tauri::command]
async fn login(api_base_url: String, state: State<'_, AppState>) -> Result<LoginResult, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let PendingLogin {
        listener,
        authorize_url,
        redirect_uri,
        state: auth_state,
        code_verifier,
    } = begin_login(&api_base_url)?;
    open::that(authorize_url.as_str()).map_err(|error| error.to_string())?;
    let callback = tokio::task::spawn_blocking(move || {
        wait_for_login_callback(listener, &auth_state, &redirect_uri)
    })
    .await
    .map_err(|error| error.to_string())??;
    let token_response = exchange_authorization_code(
        &api_base_url,
        &callback.code,
        &callback.redirect_uri,
        &code_verifier,
    )
    .await?;
    let session = session_from_token_response(&api_base_url, token_response);
    let persistence_warning = persist_session(&session).err();
    set_cached_session(&state, Some(session.clone()))?;
    Ok(LoginResult {
        user: session.user,
        session_persisted: persistence_warning.is_none(),
        persistence_warning,
    })
}

#[tauri::command]
async fn logout(api_base_url: String, state: State<'_, AppState>) -> Result<(), String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    if let Some(session) = get_cached_or_stored_session(&api_base_url, &state)? {
        let client = reqwest::Client::new();
        let _ = post_json::<_, serde_json::Value>(
            &client,
            &format!("{api_base_url}/api/desktop/auth/revoke"),
            &RevokeRequest {
                token: &session.refresh_token,
            },
        )
        .await;
    }
    clear_stored_session();
    set_cached_session(&state, None)
}

#[tauri::command]
fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    audio::list_audio_devices()
}

#[tauri::command]
fn get_recording_status(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    let recording = state.recording.lock().map_err(lock_error)?;
    Ok(RecordingStatus {
        is_recording: recording.is_some(),
        started_at: recording
            .as_ref()
            .map(|recording| recording.started_at.clone()),
    })
}

#[tauri::command]
async fn start_recording(
    api_base_url: String,
    title: Option<String>,
    tags: Vec<String>,
    mic_device_id: Option<String>,
    output_device_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStatus, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let title = normalize_optional_title(title);
    let tags = normalize_tags(tags);
    let mut recording = state.recording.lock().map_err(lock_error)?;
    if recording.is_some() {
        return Err("A recording is already in progress.".to_string());
    }

    let directory = recording_directory()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let recording_id = recording_id_from_directory(&directory)?;
    let started_at = now_iso();
    let sources = vec![
        RecordingSourceDefinition {
            source_id: "owner_mic".to_string(),
            kind: "owner_mic".to_string(),
            label: "Me".to_string(),
        },
        RecordingSourceDefinition {
            source_id: "system_output".to_string(),
            kind: "system_output".to_string(),
            label: "System/Other".to_string(),
        },
    ];
    let manifest = Arc::new(Mutex::new(create_active_recording_manifest(
        &recording_id,
        &started_at,
        title,
        tags,
        &sources,
    )));
    write_shared_recording_manifest(&directory, &manifest)?;
    let (segment_tx, segment_rx) = async_mpsc::unbounded_channel();
    let upload_task = spawn_segment_upload_worker(
        api_base_url.clone(),
        directory.clone(),
        Arc::clone(&manifest),
        segment_rx,
    );
    let mic = match start_source_capture(
        "owner_mic",
        "owner_mic",
        "Me",
        CaptureDirection::Input,
        mic_device_id,
        &directory,
        &app,
        segment_tx.clone(),
    ) {
        Ok(mic) => mic,
        Err(error) => {
            upload_task.abort();
            return Err(error);
        }
    };
    let system = match start_source_capture(
        "system_output",
        "system_output",
        "System/Other",
        CaptureDirection::Output,
        output_device_id,
        &directory,
        &app,
        segment_tx.clone(),
    ) {
        Ok(system) => system,
        Err(error) => {
            let _ = mic.capture.stop();
            let _ = mic.signal_relay.join();
            let _ = mic.segment_relay.join();
            upload_task.abort();
            return Err(error);
        }
    };

    *recording = Some(ActiveRecording {
        started_at: started_at.clone(),
        directory,
        manifest,
        segment_tx,
        upload_task,
        sources: vec![mic, system],
    });

    Ok(RecordingStatus {
        is_recording: true,
        started_at: Some(started_at),
    })
}

#[tauri::command]
async fn stop_and_upload_recording(
    api_base_url: String,
    title: Option<String>,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> Result<UploadResult, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let title = normalize_optional_title(title);
    let tags = normalize_tags(tags);
    let active = {
        let mut recording = state.recording.lock().map_err(lock_error)?;
        recording
            .take()
            .ok_or_else(|| "No recording is in progress.".to_string())?
    };
    let directory = active.directory.clone();
    let manifest = Arc::clone(&active.manifest);
    let upload_task = active.upload_task;
    stop_recording_sources(active.sources)?;
    drop(active.segment_tx);
    upload_task
        .await
        .map_err(|error| format!("Recording upload worker failed: {error}"))?;
    update_manifest_after_stop(&directory, &manifest, title.clone(), tags.clone())?;
    let upload_result =
        submit_recording_manifest(&api_base_url, &state, &directory, &manifest).await;
    match upload_result {
        Ok(job) => {
            let _ = fs::remove_dir_all(directory);
            Ok(UploadResult { job })
        }
        Err(error) => {
            mark_recording_manifest_failed(&directory, &manifest, &error)?;
            Err(format!("{error} Recording saved locally for retry."))
        }
    }
}

#[tauri::command]
fn list_retained_recordings() -> Result<Vec<RetainedRecording>, String> {
    let base = recording_base_directory()?;
    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();
    let entries = fs::read_dir(base).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = retained_manifest_path(&path);
        if !manifest_path.exists() {
            continue;
        }
        let manifest = match repair_retained_recording_manifest(&path) {
            Ok(manifest) => manifest,
            Err(error) => {
                eprintln!(
                    "Skipping unreadable retained recording manifest {}: {}",
                    manifest_path.display(),
                    error
                );
                continue;
            }
        };
        let sources = summarize_retained_sources(&manifest);
        recordings.push(RetainedRecording {
            recording_id: manifest.recording_id,
            started_at: manifest.started_at,
            stopped_at: manifest.stopped_at,
            retained_at: manifest.retained_at,
            title: manifest.title,
            tags: manifest.tags,
            status: manifest.status,
            error_message: manifest.error_message,
            local_path: path.display().to_string(),
            sources,
        });
    }
    recordings.sort_by(|a, b| b.retained_at.cmp(&a.retained_at));
    Ok(recordings)
}

#[tauri::command]
async fn retry_retained_recording(
    api_base_url: String,
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<UploadResult, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let directory = retained_recording_directory(&recording_id)?;
    let mut manifest = read_retained_recording_manifest(&directory)?;
    if manifest.status != RETAINED_RECORDING_STATUS_FAILED_UPLOAD {
        return Err(
            "This saved recording is no longer retryable. Open the folder or delete it."
                .to_string(),
        );
    }
    let shared_manifest = Arc::new(Mutex::new(manifest.clone()));
    let upload_result =
        submit_recording_manifest(&api_base_url, &state, &directory, &shared_manifest).await;
    match upload_result {
        Ok(job) => {
            if let Err(error) = fs::remove_dir_all(&directory) {
                let message = format!(
                    "Upload completed, but Chronote could not delete local saved recording files: {error}"
                );
                manifest.retained_at = now_iso();
                manifest.status = RETAINED_RECORDING_STATUS_UPLOADED_CLEANUP_FAILED.to_string();
                manifest.error_message = Some(message.clone());
                write_retained_recording_manifest_file(&directory, &manifest)?;
                return Err(format!("{message}. Open the folder or delete it manually."));
            }
            Ok(UploadResult { job })
        }
        Err(error) => {
            mark_recording_manifest_failed(&directory, &shared_manifest, &error)?;
            Err(format!(
                "{error} Recording is still saved locally for retry."
            ))
        }
    }
}

#[tauri::command]
fn open_retained_recording(recording_id: String) -> Result<(), String> {
    let directory = retained_recording_directory(&recording_id)?;
    if !directory.exists() {
        return Err("Retained recording was not found.".to_string());
    }
    open::that(directory).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_retained_recording(recording_id: String) -> Result<(), String> {
    let directory = retained_recording_directory(&recording_id)?;
    if !directory.exists() {
        return Ok(());
    }
    fs::remove_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_upload_status(
    api_base_url: String,
    upload_id: String,
    state: State<'_, AppState>,
) -> Result<UploadResult, String> {
    let api_base_url = normalize_api_base_url(&api_base_url)?;
    let client = reqwest::Client::new();
    let access_token = access_token_for(&api_base_url, &state, &client).await?;
    let response = get_json_auth::<UploadJobResponse>(
        &client,
        &format!("{api_base_url}/api/desktop/recordings/{upload_id}"),
        &access_token,
    )
    .await?;
    Ok(UploadResult { job: response.job })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|error| error.to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https URLs can be opened.".to_string());
    }
    open::that(url.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(initial_app_state())
        .invoke_handler(tauri::generate_handler![
            get_session,
            login,
            logout,
            list_audio_devices,
            get_recording_status,
            start_recording,
            stop_and_upload_recording,
            list_retained_recordings,
            retry_retained_recording,
            open_retained_recording,
            delete_retained_recording,
            get_upload_status,
            open_external_url,
            start_window_drag,
            minimize_window,
            toggle_maximize_window,
            close_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chronote Desktop");
}

fn initial_app_state() -> AppState {
    let state = AppState::default();
    #[cfg(feature = "test-hooks")]
    if let Some(session) = test_session_from_env() {
        if let Ok(mut cached_session) = state.session.lock() {
            *cached_session = Some(session);
        }
    }
    state
}

#[cfg(feature = "test-hooks")]
fn test_session_from_env() -> Option<DesktopSession> {
    if std::env::var("CHRONOTE_DESKTOP_TEST_SESSION")
        .ok()?
        .as_str()
        != "1"
    {
        return None;
    }
    let api_base_url = std::env::var("CHRONOTE_DESKTOP_TEST_API_BASE_URL")
        .or_else(|_| std::env::var("VITE_DESKTOP_API_BASE_URL"))
        .ok()
        .and_then(|value| normalize_api_base_url(&value).ok())?;
    let access_token = std::env::var("CHRONOTE_DESKTOP_TEST_ACCESS_TOKEN")
        .unwrap_or_else(|_| "chronote-desktop-smoke-access-token".to_string());
    let refresh_token = std::env::var("CHRONOTE_DESKTOP_TEST_REFRESH_TOKEN")
        .unwrap_or_else(|_| "chronote-desktop-smoke-refresh-token".to_string());
    let user_id = std::env::var("CHRONOTE_DESKTOP_TEST_USER_ID")
        .unwrap_or_else(|_| "desktop-smoke-user".to_string());
    let username = std::env::var("CHRONOTE_DESKTOP_TEST_USERNAME")
        .unwrap_or_else(|_| "Desktop Smoke Tester".to_string());

    Some(DesktopSession {
        api_base_url,
        access_token,
        refresh_token,
        expires_at: now_epoch_seconds() + 3_600,
        user: DesktopUser {
            id: user_id,
            username,
            avatar: None,
            scopes: DESKTOP_SCOPES
                .split_whitespace()
                .map(ToString::to_string)
                .collect(),
        },
    })
}

struct PendingLogin {
    listener: TcpListener,
    authorize_url: Url,
    redirect_uri: String,
    state: String,
    code_verifier: String,
}

struct LoginCallback {
    code: String,
    redirect_uri: String,
}

fn begin_login(api_base_url: &str) -> Result<PendingLogin, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
    let state = random_url_token(32);
    let code_verifier = random_url_token(32);
    let code_challenge = pkce_challenge(&code_verifier);
    let mut authorize_url = Url::parse(&format!("{api_base_url}/api/desktop/auth/authorize"))
        .map_err(|error| error.to_string())?;
    authorize_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", DESKTOP_SCOPES)
        .append_pair("state", &state);
    Ok(PendingLogin {
        listener,
        authorize_url,
        redirect_uri,
        state,
        code_verifier,
    })
}

fn wait_for_login_callback(
    listener: TcpListener,
    expected_state: &str,
    redirect_uri: &str,
) -> Result<LoginCallback, String> {
    let deadline = SystemTime::now() + Duration::from_secs(LOGIN_TIMEOUT_SECONDS);
    loop {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                let mut buffer = [0_u8; 4096];
                let size = stream
                    .read(&mut buffer)
                    .map_err(|error| error.to_string())?;
                let request = String::from_utf8_lossy(&buffer[..size]);
                let callback = parse_callback_request(&request, expected_state, redirect_uri);
                let body = match &callback {
                    Ok(_) => "Chronote Desktop sign-in complete. You can return to the app.",
                    Err(_) => "Chronote Desktop sign-in failed. You can close this tab and retry.",
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                );
                let _ = stream.write_all(response.as_bytes());
                return callback;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if SystemTime::now() > deadline {
                    return Err("Sign-in timed out.".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn parse_callback_request(
    request: &str,
    expected_state: &str,
    redirect_uri: &str,
) -> Result<LoginCallback, String> {
    let request_target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Invalid callback request.".to_string())?;
    let callback_url = Url::parse(&format!("http://127.0.0.1{request_target}"))
        .map_err(|error| error.to_string())?;
    if callback_url.path() != "/auth/callback" {
        return Err("Unexpected callback path.".to_string());
    }
    let query: HashMap<String, String> = callback_url.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(expected_state) {
        return Err("Sign-in state did not match.".to_string());
    }
    if let Some(error) = query.get("error") {
        return Err(query
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone()));
    }
    let code = query
        .get("code")
        .cloned()
        .ok_or_else(|| "Authorization code missing from callback.".to_string())?;
    Ok(LoginCallback {
        code,
        redirect_uri: redirect_uri.to_string(),
    })
}

async fn exchange_authorization_code(
    api_base_url: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    post_json(
        &client,
        &format!("{api_base_url}/api/desktop/auth/token"),
        &TokenRequest {
            grant_type: "authorization_code",
            code: Some(code),
            redirect_uri: Some(redirect_uri),
            code_verifier: Some(code_verifier),
            refresh_token: None,
        },
    )
    .await
}

async fn refresh_session(
    api_base_url: &str,
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<DesktopSession, String> {
    let token_response = post_json(
        client,
        &format!("{api_base_url}/api/desktop/auth/token"),
        &TokenRequest {
            grant_type: "refresh_token",
            code: None,
            redirect_uri: None,
            code_verifier: None,
            refresh_token: Some(refresh_token),
        },
    )
    .await?;
    Ok(session_from_token_response(api_base_url, token_response))
}

fn session_from_token_response(api_base_url: &str, response: TokenResponse) -> DesktopSession {
    DesktopSession {
        api_base_url: api_base_url.to_string(),
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at: now_epoch_seconds() + response.expires_in,
        user: DesktopUser {
            id: response.user.id,
            username: response.user.username,
            avatar: response.user.avatar,
            scopes: response
                .scope
                .split_whitespace()
                .map(ToString::to_string)
                .collect(),
        },
    }
}

async fn access_token_for(
    api_base_url: &str,
    state: &State<'_, AppState>,
    client: &reqwest::Client,
) -> Result<String, String> {
    let session = get_cached_or_stored_session(api_base_url, state)?
        .ok_or_else(|| "Sign in before uploading recordings.".to_string())?;
    if session.expires_at > now_epoch_seconds() + TOKEN_REFRESH_SKEW_SECONDS {
        return Ok(session.access_token);
    }

    let refreshed = refresh_session(api_base_url, client, &session.refresh_token).await?;
    let _ = persist_session(&refreshed);
    set_cached_session(state, Some(refreshed.clone()))?;
    Ok(refreshed.access_token)
}

async fn access_token_for_stored_session(
    api_base_url: &str,
    client: &reqwest::Client,
) -> Result<String, String> {
    let session = load_stored_session()?
        .filter(|session| session.api_base_url == api_base_url)
        .ok_or_else(|| "Sign in before uploading recordings.".to_string())?;
    if session.expires_at > now_epoch_seconds() + TOKEN_REFRESH_SKEW_SECONDS {
        return Ok(session.access_token);
    }
    let refreshed = refresh_session(api_base_url, client, &session.refresh_token).await?;
    let _ = persist_session(&refreshed);
    Ok(refreshed.access_token)
}

async fn create_recording_upload_session(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    sources: &[RetainedRecordingSourceManifest],
) -> Result<RecordingSessionResponse, String> {
    post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/session"),
        access_token,
        &RecordingSessionRequest {
            sources: sources
                .iter()
                .map(|source| RecordingSessionSourceRequest {
                    source_id: source.source_id.clone(),
                    kind: source.kind.clone(),
                    label: source.label.clone(),
                })
                .collect(),
        },
    )
    .await
}

async fn create_recording_segment_upload_intent(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    upload_id: &str,
    segment: &SegmentUploadFile,
) -> Result<RecordingSegmentIntentResponse, String> {
    post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/segment-intent"),
        access_token,
        &RecordingSegmentIntentRequest {
            upload_id: upload_id.to_string(),
            source_id: segment.source_id.clone(),
            sequence: segment.sequence,
            content_type: segment.content_type.clone(),
            file_size: segment.file_size,
            checksum_sha256: segment.checksum_sha256.clone(),
            duration_millis: segment.duration_millis,
            started_at: segment.started_at.clone(),
            ended_at: segment.ended_at.clone(),
            original_file_name: segment.file_name.clone(),
        },
    )
    .await
}

async fn upload_signed_post(
    client: &reqwest::Client,
    upload: &SignedUploadPost,
    content_type: &str,
    source: &SegmentUploadFile,
) -> Result<(), String> {
    let part = Part::file(&source.path)
        .await
        .map_err(|error| error.to_string())?
        .file_name(source.file_name.clone())
        .mime_str(content_type)
        .map_err(|error| error.to_string())?;
    let mut form = Form::new();
    for (name, value) in &upload.fields {
        form = form.text(name.clone(), value.clone());
    }
    form = form.part("file", part);
    let response = client
        .post(&upload.url)
        .multipart(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(format!("Upload failed with HTTP {}.", response.status()))
}

async fn complete_recording_segment_upload(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    upload_id: &str,
    segment: &SegmentUploadFile,
    key: String,
    upload_token: String,
) -> Result<RecordingSegmentResponse, String> {
    let response: RecordingSegmentCompleteResponse = post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/segment-complete"),
        access_token,
        &RecordingSegmentCompleteRequest {
            upload_id: upload_id.to_string(),
            source_id: segment.source_id.clone(),
            sequence: segment.sequence,
            key,
            upload_token,
        },
    )
    .await?;
    Ok(response.segment)
}

async fn submit_recording_upload(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    upload_id: &str,
    title: Option<String>,
    tags: Vec<String>,
) -> Result<UploadJob, String> {
    let response: UploadJobResponse = post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/submit"),
        access_token,
        &RecordingSubmitRequest {
            upload_id: upload_id.to_string(),
            title,
            tags,
        },
    )
    .await?;
    Ok(response.job)
}

async fn post_json<B: Serialize, T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    body: &B,
) -> Result<T, String> {
    let response = client
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    parse_api_response(response).await
}

async fn post_json_auth<B: Serialize, T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
    body: &B,
) -> Result<T, String> {
    let response = client
        .post(url)
        .bearer_auth(access_token)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    parse_api_response(response).await
}

async fn get_json_auth<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    parse_api_response(response).await
}

async fn parse_api_response<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if status.is_success() {
        return serde_json::from_str(&text).map_err(|error| error.to_string());
    }
    if let Ok(error) = serde_json::from_str::<ApiErrorBody>(&text) {
        return Err(error
            .message
            .or(error.error_description)
            .or(error.error)
            .unwrap_or_else(|| format!("Chronote API returned HTTP {status}.")));
    }
    Err(format!("Chronote API returned HTTP {status}."))
}

fn spawn_segment_upload_worker(
    api_base_url: String,
    directory: PathBuf,
    manifest: SharedRecordingManifest,
    mut segment_rx: async_mpsc::UnboundedReceiver<SealedSegmentEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = segment_rx.recv().await {
            let upload_file = match segment_upload_file_from_event(&directory, &event) {
                Ok(upload_file) => upload_file,
                Err(error) => {
                    eprintln!("Failed to read sealed recording segment: {error}");
                    continue;
                }
            };
            if let Err(error) = record_segment_sealed(&directory, &manifest, &upload_file) {
                eprintln!("Failed to update recording manifest: {error}");
                continue;
            }
            if let Err(error) =
                upload_segment_file(&api_base_url, &directory, &manifest, &upload_file, None).await
            {
                let _ = mark_segment_failed(&directory, &manifest, &upload_file, &error);
            }
        }
    })
}

async fn upload_manifest_segments(
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    access_token: Option<&str>,
) -> Result<(), String> {
    let segments = {
        let manifest = manifest.lock().map_err(lock_error)?;
        manifest
            .segments
            .iter()
            .filter(|segment| {
                !matches!(
                    segment.status.as_str(),
                    RECORDING_SEGMENT_STATUS_UPLOADED | RECORDING_SEGMENT_STATUS_SUBMITTED
                )
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    for segment in segments {
        let upload_file = segment_upload_file_from_manifest(directory, &segment)?;
        upload_segment_file(
            api_base_url,
            directory,
            manifest,
            &upload_file,
            access_token,
        )
        .await?;
    }
    Ok(())
}

async fn upload_segment_file(
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
    access_token: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let access_token = match access_token {
        Some(access_token) => access_token.to_string(),
        None => access_token_for_stored_session(api_base_url, &client).await?,
    };
    let upload_id =
        ensure_recording_upload_session(api_base_url, &access_token, &client, directory, manifest)
            .await?;
    update_segment_status(
        directory,
        manifest,
        segment,
        RECORDING_SEGMENT_STATUS_UPLOADING,
        None,
        None,
    )?;
    let intent = create_recording_segment_upload_intent(
        api_base_url,
        &access_token,
        &client,
        &upload_id,
        segment,
    )
    .await?;
    if !intent.upload_required {
        update_segment_status(
            directory,
            manifest,
            segment,
            RECORDING_SEGMENT_STATUS_UPLOADED,
            Some(intent.segment.source_s3_key),
            None,
        )?;
        return Ok(());
    }
    let upload = intent
        .upload
        .ok_or_else(|| "Segment upload intent did not include upload form.".to_string())?;
    let upload_token = intent
        .upload_token
        .ok_or_else(|| "Segment upload intent did not include upload token.".to_string())?;
    upload_signed_post(&client, &upload, &segment.content_type, segment).await?;
    let completed = complete_recording_segment_upload(
        api_base_url,
        &access_token,
        &client,
        &upload_id,
        segment,
        intent.segment.source_s3_key,
        upload_token,
    )
    .await?;
    update_segment_status(
        directory,
        manifest,
        segment,
        RECORDING_SEGMENT_STATUS_UPLOADED,
        Some(completed.source_s3_key),
        None,
    )
}

async fn ensure_recording_upload_session(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    directory: &Path,
    manifest: &SharedRecordingManifest,
) -> Result<String, String> {
    if let Some(upload_id) = manifest.lock().map_err(lock_error)?.upload_id.clone() {
        return Ok(upload_id);
    }
    let sources = manifest.lock().map_err(lock_error)?.sources.clone();
    let session =
        create_recording_upload_session(api_base_url, access_token, client, &sources).await?;
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        manifest.upload_id = Some(session.upload_id.clone());
        manifest.error_message = None;
    }
    write_shared_recording_manifest(directory, manifest)?;
    Ok(session.upload_id)
}

async fn submit_recording_manifest(
    api_base_url: &str,
    state: &State<'_, AppState>,
    directory: &Path,
    manifest: &SharedRecordingManifest,
) -> Result<UploadJob, String> {
    let client = reqwest::Client::new();
    let access_token = access_token_for(api_base_url, state, &client).await?;
    upload_manifest_segments(api_base_url, directory, manifest, Some(&access_token)).await?;
    let (upload_id, title, tags) = {
        let manifest = manifest.lock().map_err(lock_error)?;
        if manifest.segments.is_empty() {
            return Err("Recording did not produce any sealed audio segments.".to_string());
        }
        let pending = manifest.segments.iter().find(|segment| {
            !matches!(
                segment.status.as_str(),
                RECORDING_SEGMENT_STATUS_UPLOADED | RECORDING_SEGMENT_STATUS_SUBMITTED
            )
        });
        if let Some(segment) = pending {
            return Err(format!(
                "Recording segment {} #{} is not uploaded yet.",
                segment.source_id, segment.sequence
            ));
        }
        (
            manifest
                .upload_id
                .clone()
                .ok_or_else(|| "Recording upload session was not created.".to_string())?,
            manifest.title.clone(),
            manifest.tags.clone(),
        )
    };
    let job = submit_recording_upload(
        api_base_url,
        &access_token,
        &client,
        &upload_id,
        title,
        tags,
    )
    .await?;
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        manifest.status = RETAINED_RECORDING_STATUS_PENDING_UPLOAD.to_string();
        manifest.retained_at = now_iso();
        for segment in &mut manifest.segments {
            segment.status = RECORDING_SEGMENT_STATUS_SUBMITTED.to_string();
            segment.error_message = None;
        }
    }
    write_shared_recording_manifest(directory, manifest)?;
    Ok(job)
}

fn create_active_recording_manifest(
    recording_id: &str,
    started_at: &str,
    title: Option<String>,
    tags: Vec<String>,
    sources: &[RecordingSourceDefinition],
) -> RetainedRecordingManifest {
    RetainedRecordingManifest {
        version: RETAINED_RECORDING_MANIFEST_VERSION,
        recording_id: recording_id.to_string(),
        started_at: started_at.to_string(),
        stopped_at: started_at.to_string(),
        retained_at: started_at.to_string(),
        title,
        tags,
        upload_id: None,
        status: RETAINED_RECORDING_STATUS_RECORDING.to_string(),
        error_message: None,
        sources: sources
            .iter()
            .map(|source| RetainedRecordingSourceManifest {
                source_id: source.source_id.clone(),
                kind: source.kind.clone(),
                label: source.label.clone(),
            })
            .collect(),
        segments: Vec::new(),
    }
}

fn update_manifest_after_stop(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    title: Option<String>,
    tags: Vec<String>,
) -> Result<(), String> {
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        manifest.stopped_at = now_iso();
        manifest.retained_at = manifest.stopped_at.clone();
        manifest.title = title;
        manifest.tags = tags;
        manifest.status = RETAINED_RECORDING_STATUS_PENDING_UPLOAD.to_string();
    }
    write_shared_recording_manifest(directory, manifest)
}

fn mark_recording_manifest_failed(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    error_message: &str,
) -> Result<(), String> {
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        manifest.retained_at = now_iso();
        manifest.status = RETAINED_RECORDING_STATUS_FAILED_UPLOAD.to_string();
        manifest.error_message = Some(error_message.to_string());
    }
    write_shared_recording_manifest(directory, manifest)
}

fn record_segment_sealed(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
) -> Result<(), String> {
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        upsert_manifest_segment(
            &mut manifest,
            RetainedRecordingSegment {
                source_id: segment.source_id.clone(),
                sequence: segment.sequence,
                content_type: segment.content_type.clone(),
                file_name: segment.file_name.clone(),
                file_size: segment.file_size,
                checksum_sha256: segment.checksum_sha256.clone(),
                duration_millis: segment.duration_millis,
                started_at: segment.started_at.clone(),
                ended_at: segment.ended_at.clone(),
                status: RECORDING_SEGMENT_STATUS_SEALED.to_string(),
                source_s3_key: None,
                error_message: None,
            },
        );
    }
    write_shared_recording_manifest(directory, manifest)
}

fn update_segment_status(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
    status: &str,
    source_s3_key: Option<String>,
    error_message: Option<String>,
) -> Result<(), String> {
    {
        let mut manifest = manifest.lock().map_err(lock_error)?;
        if let Some(existing) = manifest.segments.iter_mut().find(|candidate| {
            candidate.source_id == segment.source_id && candidate.sequence == segment.sequence
        }) {
            existing.status = status.to_string();
            if source_s3_key.is_some() {
                existing.source_s3_key = source_s3_key;
            }
            existing.error_message = error_message;
        }
    }
    write_shared_recording_manifest(directory, manifest)
}

fn mark_segment_failed(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
    error_message: &str,
) -> Result<(), String> {
    update_segment_status(
        directory,
        manifest,
        segment,
        RECORDING_SEGMENT_STATUS_FAILED,
        None,
        Some(error_message.to_string()),
    )
}

fn upsert_manifest_segment(
    manifest: &mut RetainedRecordingManifest,
    segment: RetainedRecordingSegment,
) {
    if let Some(existing) = manifest.segments.iter_mut().find(|candidate| {
        candidate.source_id == segment.source_id && candidate.sequence == segment.sequence
    }) {
        *existing = segment;
        return;
    }
    manifest.segments.push(segment);
    manifest.segments.sort_by(|left, right| {
        (&left.source_id, left.sequence).cmp(&(&right.source_id, right.sequence))
    });
}

fn write_shared_recording_manifest(
    directory: &Path,
    manifest: &SharedRecordingManifest,
) -> Result<(), String> {
    let manifest = manifest.lock().map_err(lock_error)?.clone();
    write_retained_recording_manifest_file(directory, &manifest)
}

fn segment_upload_file_from_event(
    directory: &Path,
    event: &SealedSegmentEvent,
) -> Result<SegmentUploadFile, String> {
    let file_name = relative_recording_file_name(directory, &event.path)?;
    let metadata = fs::metadata(&event.path).map_err(|error| error.to_string())?;
    if metadata.len() <= WAV_HEADER_BYTES {
        return Err("Recorded segment was empty.".to_string());
    }
    Ok(SegmentUploadFile {
        source_id: event.source_id.clone(),
        sequence: event.segment.sequence,
        path: event.path.clone(),
        file_size: metadata.len(),
        checksum_sha256: sha256_file(&event.path)?,
        duration_millis: event.segment.duration_millis,
        started_at: epoch_millis_to_iso(event.segment.started_at_epoch_ms),
        ended_at: epoch_millis_to_iso(event.segment.ended_at_epoch_ms),
        content_type: "audio/wav".to_string(),
        file_name,
    })
}

fn segment_upload_file_from_manifest(
    directory: &Path,
    segment: &RetainedRecordingSegment,
) -> Result<SegmentUploadFile, String> {
    let path = retained_source_path(directory, &segment.file_name)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() != segment.file_size {
        return Err(format!(
            "Saved recording segment {} #{} size changed.",
            segment.source_id, segment.sequence
        ));
    }
    Ok(SegmentUploadFile {
        source_id: segment.source_id.clone(),
        sequence: segment.sequence,
        path,
        file_size: segment.file_size,
        checksum_sha256: segment.checksum_sha256.clone(),
        duration_millis: segment.duration_millis,
        started_at: segment.started_at.clone(),
        ended_at: segment.ended_at.clone(),
        content_type: segment.content_type.clone(),
        file_name: segment.file_name.clone(),
    })
}

fn relative_recording_file_name(directory: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(directory)
        .map_err(|_| "Recording segment was outside the recording directory.".to_string())?;
    let parts = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value
                .to_str()
                .map(ToString::to_string)
                .ok_or_else(|| "Recording segment path was not valid UTF-8.".to_string()),
            _ => Err("Recording segment path is invalid.".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() {
        return Err("Recording segment file name could not be resolved.".to_string());
    }
    Ok(parts.join("/"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn epoch_millis_to_iso(value: u64) -> String {
    Utc.timestamp_millis_opt(value.min(i64::MAX as u64) as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn start_source_capture(
    source_id: &str,
    kind: &str,
    label: &str,
    direction: CaptureDirection,
    device_id: Option<String>,
    directory: &Path,
    app: &tauri::AppHandle,
    segment_tx: async_mpsc::UnboundedSender<SealedSegmentEvent>,
) -> Result<RecordingSourceHandle, String> {
    let path = directory.join("segments").join(source_id);
    let (signal_tx, signal_rx) = mpsc::channel();
    let (capture_segment_tx, capture_segment_rx) = mpsc::channel();
    let signal_relay = spawn_signal_relay(app, source_id, kind, label, signal_rx)?;
    let segment_relay = spawn_segment_relay(source_id, segment_tx, capture_segment_rx)?;
    let capture = match audio::start_capture(
        direction,
        device_id,
        path.clone(),
        source_id.to_string(),
        recording_segment_duration(),
        Some(signal_tx),
        capture_segment_tx,
    ) {
        Ok(capture) => capture,
        Err(error) => {
            let _ = signal_relay.join();
            let _ = segment_relay.join();
            return Err(error);
        }
    };
    Ok(RecordingSourceHandle {
        capture,
        signal_relay,
        segment_relay,
    })
}

fn spawn_signal_relay(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
    label: &str,
    signal_rx: mpsc::Receiver<CaptureSignalLevel>,
) -> Result<JoinHandle<()>, String> {
    let app = app.clone();
    let source_id = source_id.to_string();
    let kind = kind.to_string();
    let label = label.to_string();
    thread::Builder::new()
        .name(format!("chronote-{source_id}-signal-relay"))
        .spawn(move || {
            for signal in signal_rx {
                let _ = app.emit(
                    RECORDING_SOURCE_SIGNAL_EVENT,
                    RecordingSourceSignal {
                        source_id: source_id.clone(),
                        kind: kind.clone(),
                        label: label.clone(),
                        peak_level: signal.peak_level,
                        rms_level: signal.rms_level,
                        sample_count: signal.sample_count,
                        updated_at_epoch_ms: signal.updated_at_epoch_ms,
                    },
                );
            }
        })
        .map_err(|error| error.to_string())
}

fn spawn_segment_relay(
    source_id: &str,
    segment_tx: async_mpsc::UnboundedSender<SealedSegmentEvent>,
    segment_rx: mpsc::Receiver<CaptureSegment>,
) -> Result<JoinHandle<()>, String> {
    let source_id = source_id.to_string();
    thread::Builder::new()
        .name(format!("chronote-{source_id}-segment-relay"))
        .spawn(move || {
            for segment in segment_rx {
                let _ = segment_tx.send(SealedSegmentEvent {
                    source_id: source_id.clone(),
                    path: segment.path.clone(),
                    segment,
                });
            }
        })
        .map_err(|error| error.to_string())
}

fn stop_recording_sources(sources: Vec<RecordingSourceHandle>) -> Result<(), String> {
    let mut first_error: Option<String> = None;
    for source in sources {
        if let Err(error) = source.capture.stop() {
            first_error.get_or_insert(error);
        }
        if let Err(error) = source
            .signal_relay
            .join()
            .map_err(|_| "Recording signal relay thread panicked.".to_string())
        {
            first_error.get_or_insert(error);
        }
        if let Err(error) = source
            .segment_relay
            .join()
            .map_err(|_| "Recording segment relay thread panicked.".to_string())
        {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn recording_segment_duration() -> Duration {
    let seconds = std::env::var("CHRONOTE_DESKTOP_SEGMENT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(RECORDING_SEGMENT_SECONDS);
    Duration::from_secs(seconds)
}

fn get_cached_or_stored_session(
    api_base_url: &str,
    state: &State<'_, AppState>,
) -> Result<Option<DesktopSession>, String> {
    if let Some(session) = state.session.lock().map_err(lock_error)?.clone() {
        if session.api_base_url == api_base_url {
            return Ok(Some(session));
        }
    }
    let stored = load_stored_session()?;
    let matching = stored.filter(|session| session.api_base_url == api_base_url);
    if let Some(session) = matching.clone() {
        set_cached_session(state, Some(session))?;
    } else {
        set_cached_session(state, None)?;
    }
    Ok(matching)
}

fn set_cached_session(
    state: &State<'_, AppState>,
    session: Option<DesktopSession>,
) -> Result<(), String> {
    *state.session.lock().map_err(lock_error)? = session;
    Ok(())
}

fn load_stored_session() -> Result<Option<DesktopSession>, String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn store_session(session: &DesktopSession) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())?;
    entry
        .set_password(&serde_json::to_string(session).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn persist_session(session: &DesktopSession) -> Result<(), String> {
    store_session(session)?;
    match load_stored_session()? {
        Some(stored)
            if stored.api_base_url == session.api_base_url
                && stored.refresh_token == session.refresh_token
                && stored.user.id == session.user.id =>
        {
            Ok(())
        }
        Some(_) => Err("Credential store returned a different Chronote session.".to_string()),
        None => Err("Credential store did not return the saved Chronote session.".to_string()),
    }
}

fn clear_stored_session() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

fn normalize_api_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Chronote API URL must use http or https.".to_string());
    }
    Ok(value.to_string())
}

fn recording_directory() -> Result<PathBuf, String> {
    Ok(recording_base_directory()?.join(Uuid::new_v4().to_string()))
}

fn normalize_optional_title(title: Option<String>) -> Option<String> {
    title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .take(20)
        .collect()
}

fn recording_base_directory() -> Result<PathBuf, String> {
    let base = ProjectDirs::from("gg", "Chronote", "Chronote Desktop")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("chronote-desktop"));
    Ok(base.join("recordings"))
}

fn retained_recording_directory(recording_id: &str) -> Result<PathBuf, String> {
    let recording_uuid =
        Uuid::parse_str(recording_id).map_err(|_| "Invalid retained recording ID.".to_string())?;
    Ok(recording_base_directory()?.join(recording_uuid.to_string()))
}

fn retained_manifest_path(directory: &Path) -> PathBuf {
    directory.join(RETAINED_RECORDING_MANIFEST_FILE)
}

fn recording_id_from_directory(directory: &Path) -> Result<String, String> {
    directory
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "Recording directory name could not be resolved.".to_string())
}

fn write_retained_recording_manifest_file(
    directory: &Path,
    manifest: &RetainedRecordingManifest,
) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    fs::write(retained_manifest_path(directory), body).map_err(|error| error.to_string())
}

fn read_retained_recording_manifest(directory: &Path) -> Result<RetainedRecordingManifest, String> {
    let body =
        fs::read_to_string(retained_manifest_path(directory)).map_err(|error| error.to_string())?;
    let manifest: RetainedRecordingManifest =
        serde_json::from_str(&body).map_err(|error| error.to_string())?;
    if manifest.version != RETAINED_RECORDING_MANIFEST_VERSION {
        return Err("Retained recording manifest version is unsupported.".to_string());
    }
    Ok(manifest)
}

fn repair_retained_recording_manifest(
    directory: &Path,
) -> Result<RetainedRecordingManifest, String> {
    let mut manifest = read_retained_recording_manifest(directory)?;
    let mut repaired = false;
    if manifest.status == RETAINED_RECORDING_STATUS_RECORDING {
        manifest.status = RETAINED_RECORDING_STATUS_FAILED_UPLOAD.to_string();
        manifest.stopped_at = now_iso();
        manifest.retained_at = manifest.stopped_at.clone();
        manifest.error_message = Some(
            "Chronote Desktop stopped before the recording ended. Sealed segments were recovered; the active segment may be incomplete."
                .to_string(),
        );
        repaired = true;
    }
    for source in manifest.sources.clone() {
        let source_dir = directory.join("segments").join(&source.source_id);
        if !source_dir.exists() {
            continue;
        }
        for entry in fs::read_dir(source_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("wav") {
                continue;
            }
            let file_name = relative_recording_file_name(directory, &path)?;
            if manifest
                .segments
                .iter()
                .any(|segment| segment.file_name == file_name)
            {
                continue;
            }
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if metadata.len() <= WAV_HEADER_BYTES {
                continue;
            }
            let sequence = sequence_from_segment_file(&path)?;
            let started_at = manifest.started_at.clone();
            let ended_at = manifest.stopped_at.clone();
            upsert_manifest_segment(
                &mut manifest,
                RetainedRecordingSegment {
                    source_id: source.source_id.clone(),
                    sequence,
                    content_type: "audio/wav".to_string(),
                    file_name,
                    file_size: metadata.len(),
                    checksum_sha256: sha256_file(&path)?,
                    duration_millis: estimate_wav_duration_millis(metadata.len()),
                    started_at,
                    ended_at,
                    status: RECORDING_SEGMENT_STATUS_SEALED.to_string(),
                    source_s3_key: None,
                    error_message: None,
                },
            );
            repaired = true;
        }
    }
    if repaired {
        write_retained_recording_manifest_file(directory, &manifest)?;
    }
    Ok(manifest)
}

fn summarize_retained_sources(
    manifest: &RetainedRecordingManifest,
) -> Vec<RetainedRecordingSource> {
    manifest
        .sources
        .iter()
        .map(|source| {
            let source_segments = manifest
                .segments
                .iter()
                .filter(|segment| segment.source_id == source.source_id)
                .collect::<Vec<_>>();
            RetainedRecordingSource {
                source_id: source.source_id.clone(),
                kind: source.kind.clone(),
                label: source.label.clone(),
                file_size: source_segments
                    .iter()
                    .map(|segment| segment.file_size)
                    .sum(),
                segment_count: source_segments.len(),
                uploaded_segment_count: source_segments
                    .iter()
                    .filter(|segment| {
                        matches!(
                            segment.status.as_str(),
                            RECORDING_SEGMENT_STATUS_UPLOADED | RECORDING_SEGMENT_STATUS_SUBMITTED
                        )
                    })
                    .count(),
            }
        })
        .collect()
}

fn sequence_from_segment_file(path: &Path) -> Result<u32, String> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Recording segment file name could not be read.".to_string())?;
    stem.rsplit('-')
        .next()
        .ok_or_else(|| "Recording segment sequence could not be read.".to_string())?
        .parse::<u32>()
        .map_err(|error| error.to_string())
}

fn estimate_wav_duration_millis(file_size: u64) -> u64 {
    let payload_bytes = file_size.saturating_sub(WAV_HEADER_BYTES);
    let samples = payload_bytes / 4;
    ((samples.saturating_mul(1000)) / 48_000).max(1)
}

fn retained_source_path(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(file_name);
    if relative_path.components().next().is_none()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Retained recording source file name is invalid.".to_string());
    }
    Ok(directory.join(relative_path))
}

fn random_url_token(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(code_verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_retained_manifest_recovers_sealed_segments() {
        let directory = std::env::temp_dir().join(format!(
            "chronote-retained-recording-test-{}",
            Uuid::new_v4()
        ));
        let source_dir = directory.join("segments").join("owner_mic");
        fs::create_dir_all(&source_dir).unwrap();
        let segment_path = source_dir.join("owner_mic-000000.wav");
        fs::write(&segment_path, vec![0_u8; (WAV_HEADER_BYTES + 8) as usize]).unwrap();
        let manifest = RetainedRecordingManifest {
            version: RETAINED_RECORDING_MANIFEST_VERSION,
            recording_id: "recording-1".to_string(),
            started_at: "2026-06-15T00:00:00.000Z".to_string(),
            stopped_at: "2026-06-15T00:00:00.000Z".to_string(),
            retained_at: "2026-06-15T00:00:00.000Z".to_string(),
            title: Some("Planning".to_string()),
            tags: vec!["research".to_string()],
            upload_id: None,
            status: RETAINED_RECORDING_STATUS_RECORDING.to_string(),
            error_message: None,
            sources: vec![RetainedRecordingSourceManifest {
                source_id: "owner_mic".to_string(),
                kind: "owner_mic".to_string(),
                label: "Me".to_string(),
            }],
            segments: Vec::new(),
        };
        write_retained_recording_manifest_file(&directory, &manifest).unwrap();

        let repaired = repair_retained_recording_manifest(&directory).unwrap();
        let sources = summarize_retained_sources(&repaired);

        assert!(segment_path.exists());
        assert_eq!(repaired.status, RETAINED_RECORDING_STATUS_FAILED_UPLOAD);
        assert_eq!(repaired.segments.len(), 1);
        assert_eq!(repaired.segments[0].source_id, "owner_mic");
        assert_eq!(repaired.segments[0].sequence, 0);
        assert_eq!(repaired.segments[0].status, RECORDING_SEGMENT_STATUS_SEALED);
        assert_eq!(repaired.segments[0].file_size, WAV_HEADER_BYTES + 8);
        assert_eq!(sources[0].segment_count, 1);
        assert_eq!(sources[0].uploaded_segment_count, 0);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retained_source_path_rejects_traversal() {
        let directory = std::env::temp_dir().join(format!(
            "chronote-retained-recording-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();

        let error = match retained_source_path(&directory, "../secret.wav") {
            Ok(_) => panic!("nested source file name should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("file name is invalid"));

        fs::remove_dir_all(directory).unwrap();
    }
}
