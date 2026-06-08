mod audio;

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use audio::{AudioDevice, CaptureDirection, CaptureHandle, CaptureSignalLevel};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use directories::ProjectDirs;
use rand::{rngs::OsRng, RngCore};
use reqwest::multipart::{Form, Part};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, State};
use url::Url;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "Chronote Desktop";
const KEYRING_ACCOUNT: &str = "chronote-desktop-session";
const TOKEN_REFRESH_SKEW_SECONDS: u64 = 60;
const LOGIN_TIMEOUT_SECONDS: u64 = 300;
const DESKTOP_SCOPES: &str = "profile:read personal_uploads:write meetings:read";
const WAV_HEADER_BYTES: u64 = 44;

#[derive(Default)]
struct AppState {
    session: Mutex<Option<DesktopSession>>,
    recording: Mutex<Option<ActiveRecording>>,
}

struct ActiveRecording {
    started_at: String,
    sources: Vec<RecordingSourceHandle>,
}

struct RecordingSourceHandle {
    source_id: String,
    kind: String,
    label: String,
    path: PathBuf,
    capture: CaptureHandle,
    signal_relay: JoinHandle<()>,
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
struct RecordingIntentResponse {
    upload_id: String,
    sources: Vec<RecordingIntentSourceResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingIntentSourceResponse {
    source_id: String,
    source_s3_key: String,
    content_type: String,
    upload_token: String,
    upload: SignedUploadPost,
}

#[derive(Deserialize)]
struct SignedUploadPost {
    url: String,
    fields: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingIntentRequest {
    sources: Vec<RecordingIntentSourceRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingIntentSourceRequest {
    source_id: String,
    kind: String,
    label: String,
    content_type: String,
    file_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingCompleteRequest {
    upload_id: String,
    sources: Vec<RecordingCompleteSourceRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingCompleteSourceRequest {
    source_id: String,
    key: String,
    upload_token: String,
    original_file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadJobResponse {
    job: UploadJob,
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

struct CapturedSourceFile {
    source_id: String,
    kind: String,
    label: String,
    path: PathBuf,
    file_size: u64,
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
fn start_recording(
    mic_device_id: Option<String>,
    output_device_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStatus, String> {
    let mut recording = state.recording.lock().map_err(lock_error)?;
    if recording.is_some() {
        return Err("A recording is already in progress.".to_string());
    }

    let directory = recording_directory()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let started_at = now_iso();
    let mic = start_source_capture(
        "owner_mic",
        "owner_mic",
        "Me",
        CaptureDirection::Input,
        mic_device_id,
        &directory,
        &app,
    )?;
    let system = match start_source_capture(
        "system_output",
        "system_output",
        "System/Other",
        CaptureDirection::Output,
        output_device_id,
        &directory,
        &app,
    ) {
        Ok(system) => system,
        Err(error) => {
            let _ = mic.capture.stop();
            let _ = mic.signal_relay.join();
            return Err(error);
        }
    };

    *recording = Some(ActiveRecording {
        started_at: started_at.clone(),
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
    let active = {
        let mut recording = state.recording.lock().map_err(lock_error)?;
        recording
            .take()
            .ok_or_else(|| "No recording is in progress.".to_string())?
    };
    let sources = stop_recording_sources(active)?;
    let cleanup_dir = sources
        .first()
        .and_then(|source| source.path.parent())
        .map(Path::to_path_buf);
    let client = reqwest::Client::new();
    let upload_result = async {
        let access_token = access_token_for(&api_base_url, &state, &client).await?;
        let intent =
            create_recording_upload_intent(&api_base_url, &access_token, &client, &sources).await?;
        upload_sources(&client, &intent, &sources).await?;
        complete_recording_upload(
            &api_base_url,
            &access_token,
            &client,
            intent,
            title.filter(|value| !value.trim().is_empty()),
            tags,
        )
        .await
    }
    .await;
    if let Some(cleanup_dir) = cleanup_dir {
        let _ = fs::remove_dir_all(cleanup_dir);
    }
    let job = upload_result?;
    Ok(UploadResult { job })
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

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_session,
            login,
            logout,
            list_audio_devices,
            get_recording_status,
            start_recording,
            stop_and_upload_recording,
            get_upload_status,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chronote Desktop");
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

async fn create_recording_upload_intent(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    sources: &[CapturedSourceFile],
) -> Result<RecordingIntentResponse, String> {
    post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/intent"),
        access_token,
        &RecordingIntentRequest {
            sources: sources
                .iter()
                .map(|source| RecordingIntentSourceRequest {
                    source_id: source.source_id.clone(),
                    kind: source.kind.clone(),
                    label: source.label.clone(),
                    content_type: "audio/wav".to_string(),
                    file_size: source.file_size,
                })
                .collect(),
        },
    )
    .await
}

async fn upload_sources(
    client: &reqwest::Client,
    intent: &RecordingIntentResponse,
    sources: &[CapturedSourceFile],
) -> Result<(), String> {
    for source in sources {
        let intent_source = intent
            .sources
            .iter()
            .find(|intent_source| intent_source.source_id == source.source_id)
            .ok_or_else(|| "Upload intent did not include all recording sources.".to_string())?;
        upload_signed_post(client, intent_source, source).await?;
    }
    Ok(())
}

async fn upload_signed_post(
    client: &reqwest::Client,
    intent_source: &RecordingIntentSourceResponse,
    source: &CapturedSourceFile,
) -> Result<(), String> {
    let bytes = tokio::fs::read(&source.path)
        .await
        .map_err(|error| error.to_string())?;
    let file_name = source_file_name(&source.path)?;
    let part = Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&intent_source.content_type)
        .map_err(|error| error.to_string())?;
    let mut form = Form::new();
    for (name, value) in &intent_source.upload.fields {
        form = form.text(name.clone(), value.clone());
    }
    form = form.part("file", part);
    let response = client
        .post(&intent_source.upload.url)
        .multipart(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(format!("Upload failed with HTTP {}.", response.status()))
}

async fn complete_recording_upload(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    intent: RecordingIntentResponse,
    title: Option<String>,
    tags: Vec<String>,
) -> Result<UploadJob, String> {
    let response: UploadJobResponse = post_json_auth(
        client,
        &format!("{api_base_url}/api/desktop/recordings/complete"),
        access_token,
        &RecordingCompleteRequest {
            upload_id: intent.upload_id,
            sources: intent
                .sources
                .into_iter()
                .map(|source| RecordingCompleteSourceRequest {
                    original_file_name: format!("{}.wav", source.source_id),
                    source_id: source.source_id,
                    key: source.source_s3_key,
                    upload_token: source.upload_token,
                })
                .collect(),
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

fn start_source_capture(
    source_id: &str,
    kind: &str,
    label: &str,
    direction: CaptureDirection,
    device_id: Option<String>,
    directory: &Path,
    app: &tauri::AppHandle,
) -> Result<RecordingSourceHandle, String> {
    let path = directory.join(format!("{source_id}.wav"));
    let (signal_tx, signal_rx) = mpsc::channel();
    let signal_relay = spawn_signal_relay(app, source_id, kind, label, signal_rx)?;
    let capture = match audio::start_capture(direction, device_id, path.clone(), Some(signal_tx)) {
        Ok(capture) => capture,
        Err(error) => {
            let _ = signal_relay.join();
            return Err(error);
        }
    };
    Ok(RecordingSourceHandle {
        source_id: source_id.to_string(),
        kind: kind.to_string(),
        label: label.to_string(),
        path,
        capture,
        signal_relay,
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
                    "recording-source-signal",
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

fn stop_recording_sources(active: ActiveRecording) -> Result<Vec<CapturedSourceFile>, String> {
    let mut sources = Vec::new();
    for source in active.sources {
        let path = source.path.clone();
        source.capture.stop()?;
        source
            .signal_relay
            .join()
            .map_err(|_| "Recording signal relay thread panicked.".to_string())?;
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() <= WAV_HEADER_BYTES {
            return Err("Recorded audio source was empty.".to_string());
        }
        sources.push(CapturedSourceFile {
            source_id: source.source_id,
            kind: source.kind,
            label: source.label,
            path,
            file_size: metadata.len(),
        });
    }
    Ok(sources)
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
    let base = ProjectDirs::from("gg", "Chronote", "Chronote Desktop")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("chronote-desktop"));
    Ok(base.join("recordings").join(Uuid::new_v4().to_string()))
}

fn source_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "Recording file name could not be resolved.".to_string())
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
