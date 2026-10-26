use super::*;

#[derive(Debug)]
pub(super) enum RecordingUploadError {
    Paused(String),
    Other(String),
}

impl From<String> for RecordingUploadError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl std::fmt::Display for RecordingUploadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Paused(message) | Self::Other(message) => formatter.write_str(message),
        }
    }
}

fn require_unpaused_manifest(
    manifest: &SharedRecordingManifest,
) -> Result<(), RecordingUploadError> {
    if manifest.lock().map_err(lock_error)?.status == RETAINED_RECORDING_STATUS_PAUSED {
        return Err(RecordingUploadError::Paused(
            PAUSED_DRAFT_MESSAGE.to_string(),
        ));
    }
    Ok(())
}

fn retain_pause_result<T>(
    directory: &Path,
    manifest: &SharedRecordingManifest,
    result: Result<T, RecordingUploadError>,
) -> Result<T, RecordingUploadError> {
    if let Err(RecordingUploadError::Paused(message)) = &result {
        {
            let mut manifest = manifest.lock().map_err(lock_error)?;
            manifest.status = RETAINED_RECORDING_STATUS_PAUSED.to_string();
            manifest.error_message = Some(message.clone());
            manifest.retained_at = now_iso();
        }
        write_shared_recording_manifest(directory, manifest).map_err(|error| RecordingUploadError::Other(format!("{message} Could not save the paused state: {error}. Recording files remain on this computer.")))?;
    }
    result
}

async fn post_recording_json<B: Serialize, T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
    body: &B,
) -> Result<T, RecordingUploadError> {
    let response = client
        .post(url)
        .bearer_auth(access_token)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if status.is_success() {
        return serde_json::from_str(&text)
            .map_err(|error| RecordingUploadError::Other(error.to_string()));
    }
    if let Ok(error) = serde_json::from_str::<ApiErrorBody>(&text) {
        let paused = error.error.as_deref() == Some("paused");
        let message = error
            .message
            .or(error.error_description)
            .or(error.error)
            .unwrap_or_else(|| format!("Chronote API returned HTTP {status}."));
        return Err(if paused {
            RecordingUploadError::Paused(message)
        } else {
            RecordingUploadError::Other(message)
        });
    }
    Err(RecordingUploadError::Other(format!(
        "Chronote API returned HTTP {status}."
    )))
}

pub(super) async fn upload_segment_file(
    app: Option<&tauri::AppHandle>,
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
    access_token: Option<&str>,
    session: Option<&mut Option<DesktopSession>>,
) -> Result<(), RecordingUploadError> {
    require_unpaused_manifest(manifest)?;
    let result = upload_segment_file_inner(
        app,
        api_base_url,
        directory,
        manifest,
        segment,
        access_token,
        session,
    )
    .await;
    retain_pause_result(directory, manifest, result)
}

async fn create_recording_upload_session(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    sources: &[RetainedRecordingSourceManifest],
) -> Result<RecordingSessionResponse, RecordingUploadError> {
    post_recording_json(
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
) -> Result<RecordingSegmentIntentResponse, RecordingUploadError> {
    post_recording_json(
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
) -> Result<RecordingSegmentResponse, RecordingUploadError> {
    let response: RecordingSegmentCompleteResponse = post_recording_json(
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
) -> Result<UploadJob, RecordingUploadError> {
    let response: UploadJobResponse = post_recording_json(
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
    if response.job.status == RETAINED_RECORDING_STATUS_PAUSED {
        return Err(RecordingUploadError::Paused(
            response
                .job
                .error_message
                .unwrap_or_else(|| PAUSED_DRAFT_MESSAGE.to_string()),
        ));
    }
    Ok(response.job)
}

async fn upload_manifest_segments(
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    access_token: Option<&str>,
) -> Result<(), RecordingUploadError> {
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
            None,
            api_base_url,
            directory,
            manifest,
            &upload_file,
            access_token,
            None,
        )
        .await?;
    }
    Ok(())
}

async fn upload_segment_file_inner(
    app: Option<&tauri::AppHandle>,
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    segment: &SegmentUploadFile,
    access_token: Option<&str>,
    session: Option<&mut Option<DesktopSession>>,
) -> Result<(), RecordingUploadError> {
    let client = reqwest::Client::new();
    let access_token = match access_token {
        Some(access_token) => access_token.to_string(),
        None => match session {
            Some(session) => {
                access_token_for_session_snapshot(
                    api_base_url,
                    &client,
                    app.ok_or_else(|| {
                        "Recording upload worker state was unavailable.".to_string()
                    })?,
                    session,
                )
                .await?
            }
            None => access_token_for_stored_session(api_base_url, &client).await?,
        },
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
    Ok(update_segment_status(
        directory,
        manifest,
        segment,
        RECORDING_SEGMENT_STATUS_UPLOADED,
        Some(completed.source_s3_key),
        None,
    )?)
}

async fn ensure_recording_upload_session(
    api_base_url: &str,
    access_token: &str,
    client: &reqwest::Client,
    directory: &Path,
    manifest: &SharedRecordingManifest,
) -> Result<String, RecordingUploadError> {
    require_unpaused_manifest(manifest)?;
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

pub(super) async fn submit_recording_manifest(
    api_base_url: &str,
    state: &State<'_, AppState>,
    directory: &Path,
    manifest: &SharedRecordingManifest,
) -> Result<UploadJob, RecordingUploadError> {
    require_unpaused_manifest(manifest)?;
    let client = reqwest::Client::new();
    let access_token = access_token_for(api_base_url, state, &client).await?;
    submit_recording_manifest_with_token(api_base_url, directory, manifest, &access_token).await
}

async fn submit_recording_manifest_with_token(
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    access_token: &str,
) -> Result<UploadJob, RecordingUploadError> {
    require_unpaused_manifest(manifest)?;
    let result =
        submit_recording_manifest_inner(api_base_url, directory, manifest, access_token).await;
    retain_pause_result(directory, manifest, result)
}

async fn submit_recording_manifest_inner(
    api_base_url: &str,
    directory: &Path,
    manifest: &SharedRecordingManifest,
    access_token: &str,
) -> Result<UploadJob, RecordingUploadError> {
    let client = reqwest::Client::new();
    upload_manifest_segments(api_base_url, directory, manifest, Some(access_token)).await?;
    let (upload_id, title, tags) = {
        let manifest = manifest.lock().map_err(lock_error)?;
        if manifest.segments.is_empty() {
            return Err("Recording did not produce any sealed audio segments."
                .to_string()
                .into());
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
            )
            .into());
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

#[cfg(test)]
mod tests;
