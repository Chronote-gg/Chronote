use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct ApiStub {
    url: String,
    requests: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ApiStub {
    fn new(responses: Vec<(&'static str, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let count = Arc::clone(&requests);
        let stop = Arc::clone(&stopped);
        let response_url = url.clone();
        let thread = thread::spawn(move || {
            let mut responses = responses.into_iter();
            while !stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                // TCP reads can split both headers and the streamed multipart body.
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    assert!(headers.len() < 8192, "stub request headers exceeded limit");
                    let mut byte = [0_u8; 1];
                    stream
                        .read_exact(&mut byte)
                        .expect("incomplete request headers");
                    headers.push(byte[0]);
                }
                let headers = std::str::from_utf8(&headers).unwrap();
                let mut content_length = None;
                for line in headers.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        assert!(
                            !name.eq_ignore_ascii_case("transfer-encoding"),
                            "stub expects length-delimited reqwest requests"
                        );
                        if name.eq_ignore_ascii_case("content-length") {
                            assert!(content_length.is_none(), "duplicate content length");
                            content_length = Some(value.trim().parse::<u64>().unwrap());
                        }
                    }
                }
                let content_length = content_length.expect("stub request needs content length");
                assert!(
                    content_length <= 1024 * 1024,
                    "stub request body exceeded limit"
                );
                let received = std::io::copy(
                    &mut (&mut stream).take(content_length),
                    &mut std::io::sink(),
                )
                .unwrap();
                assert_eq!(received, content_length, "incomplete request body");
                count.fetch_add(1, Ordering::SeqCst);
                let (status, body) = responses.next().expect("unexpected network retry");
                let body = body.replace("$BASE_URL", &response_url);
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            url,
            requests,
            stopped,
            thread: Some(thread),
        }
    }
}

impl Drop for ApiStub {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

#[test]
fn api_stub_waits_for_fragmented_headers_and_complete_body() {
    let api = ApiStub::new(vec![("204 No Content", String::new())]);
    let mut stream = std::net::TcpStream::connect(api.url.trim_start_matches("http://")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let mut response = [0_u8; 256];
    for fragment in [
        &b"POST /storage HTTP/1.1\r\nContent-Len"[..],
        &b"gth: 6\r\n\r\nabc"[..],
    ] {
        stream.write_all(fragment).unwrap();
        let result = stream.read(&mut response);
        assert!(
            matches!(&result, Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)),
            "stub responded before the complete request: {result:?}"
        );
        assert_eq!(api.requests.load(Ordering::SeqCst), 0);
    }
    stream.write_all(b"def").unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    assert!(response.starts_with(b"HTTP/1.1 204 No Content\r\n"));
    assert_eq!(api.requests.load(Ordering::SeqCst), 1);
}

struct Draft {
    directory: PathBuf,
    manifest: SharedRecordingManifest,
    bytes: Vec<u8>,
}

impl Draft {
    fn new(segment_status: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("chronote-paused-test-{}", Uuid::new_v4()));
        let source_dir = directory.join("segments/owner_mic");
        fs::create_dir_all(&source_dir).unwrap();
        let bytes = (0..100).collect::<Vec<u8>>();
        fs::write(source_dir.join("owner_mic-000000.wav"), &bytes).unwrap();
        let manifest = create_active_recording_manifest(
            "original-recording",
            "2026-06-15T00:00:00.000Z",
            Some("Saved draft".to_string()),
            vec!["research".to_string()],
            &[RecordingSourceDefinition {
                source_id: "owner_mic".to_string(),
                kind: "owner_mic".to_string(),
                label: "Me".to_string(),
            }],
        );
        write_retained_recording_manifest_file(&directory, &manifest).unwrap();
        let mut manifest = repair_retained_recording_manifest(&directory).unwrap();
        manifest.upload_id = Some("original-upload".to_string());
        manifest.segments[0].status = segment_status.to_string();
        manifest.segments[0].source_s3_key = Some("original-input".to_string());
        write_retained_recording_manifest_file(&directory, &manifest).unwrap();
        Self {
            directory,
            manifest: Arc::new(Mutex::new(manifest)),
            bytes,
        }
    }

    fn assert_preserved(&self) {
        let before = self.manifest.lock().unwrap().clone();
        let reloaded = repair_retained_recording_manifest(&self.directory).unwrap();
        assert_eq!(reloaded.status, RETAINED_RECORDING_STATUS_PAUSED);
        assert_eq!(reloaded.upload_id.as_deref(), Some("original-upload"));
        assert_eq!(reloaded.recording_id, "original-recording");
        assert_eq!(reloaded.title.as_deref(), Some("Saved draft"));
        assert_eq!(reloaded.tags, ["research"]);
        assert_eq!(
            serde_json::to_value(&reloaded.sources).unwrap(),
            serde_json::to_value(&before.sources).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&reloaded.segments).unwrap(),
            serde_json::to_value(&before.segments).unwrap()
        );
        assert_ne!(
            reloaded.segments[0].status,
            RECORDING_SEGMENT_STATUS_SUBMITTED
        );
        assert_eq!(
            fs::read(self.directory.join(&reloaded.segments[0].file_name)).unwrap(),
            self.bytes
        );
    }
}

impl Drop for Draft {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn pause_response() -> (&'static str, String) {
    // Deliberately unrelated copy proves the code, rather than text, controls the state.
    (
        "409 Conflict",
        serde_json::json!({"error": "paused", "message": "Preserved by server"}).to_string(),
    )
}

#[test]
fn structured_segment_pause_preserves_draft_and_refuses_next_network_retry() {
    tauri::async_runtime::block_on(async {
        let api = ApiStub::new(vec![pause_response()]);
        let draft = Draft::new(RECORDING_SEGMENT_STATUS_SEALED);
        let result = submit_recording_manifest_with_token(
            &api.url,
            &draft.directory,
            &draft.manifest,
            "test-token",
        )
        .await;
        assert!(matches!(result, Err(RecordingUploadError::Paused(_))));
        draft.assert_preserved();
        let reloaded = Arc::new(Mutex::new(
            read_retained_recording_manifest(&draft.directory).unwrap(),
        ));
        assert!(matches!(
            submit_recording_manifest_with_token(
                &api.url,
                &draft.directory,
                &reloaded,
                "test-token"
            )
            .await,
            Err(RecordingUploadError::Paused(_))
        ));
        assert_eq!(api.requests.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn segment_completion_pause_preserves_original_metadata_and_bytes() {
    tauri::async_runtime::block_on(async {
        let intent = serde_json::json!({
            "segment": { "sourceS3Key": "original-input" },
            "uploadRequired": true, "uploadToken": "test-upload-token",
            "upload": {"url": "$BASE_URL/storage", "fields": {}}
        })
        .to_string();
        let api = ApiStub::new(vec![
            ("200 OK", intent),
            ("204 No Content", String::new()),
            pause_response(),
        ]);
        let draft = Draft::new(RECORDING_SEGMENT_STATUS_SEALED);
        let result = submit_recording_manifest_with_token(
            &api.url,
            &draft.directory,
            &draft.manifest,
            "test-token",
        )
        .await;
        assert!(
            matches!(&result, Err(RecordingUploadError::Paused(_))),
            "error={:?}; requests={}",
            result.as_ref().err(),
            api.requests.load(Ordering::SeqCst)
        );
        draft.assert_preserved();
        assert_eq!(
            draft.manifest.lock().unwrap().segments[0]
                .source_s3_key
                .as_deref(),
            Some("original-input")
        );
        assert!(matches!(
            submit_recording_manifest_with_token(
                &api.url,
                &draft.directory,
                &draft.manifest,
                "test-token"
            )
            .await,
            Err(RecordingUploadError::Paused(_))
        ));
        assert_eq!(api.requests.load(Ordering::SeqCst), 3);
    });
}

#[test]
fn parent_pause_and_defensive_paused_success_never_submit_segments_or_cleanup() {
    tauri::async_runtime::block_on(async {
        for response in [pause_response(), ("200 OK", serde_json::json!({"job": {"uploadId": "original-upload", "status": "paused", "retryable": false, "errorMessage": PAUSED_DRAFT_MESSAGE}}).to_string())] {
            let api = ApiStub::new(vec![response]);
            let draft = Draft::new(RECORDING_SEGMENT_STATUS_UPLOADED);
            assert!(matches!(submit_recording_manifest_with_token(&api.url, &draft.directory, &draft.manifest, "test-token").await, Err(RecordingUploadError::Paused(_))));
            mark_recording_manifest_failed(&draft.directory, &draft.manifest, "outer failure handler").unwrap();
            update_manifest_after_stop(&draft.directory, &draft.manifest, Some("Saved draft".to_string()), vec!["research".to_string()]).unwrap();
            draft.assert_preserved();
            assert!(matches!(submit_recording_manifest_with_token(&api.url, &draft.directory, &draft.manifest, "test-token").await, Err(RecordingUploadError::Paused(_))));
            assert_eq!(api.requests.load(Ordering::SeqCst), 1);
        }
    });
}

#[test]
fn pause_persistence_failure_reports_failure_and_keeps_file_bytes() {
    let draft = Draft::new(RECORDING_SEGMENT_STATUS_UPLOADED);
    let path = retained_manifest_path(&draft.directory);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let result: Result<(), _> = retain_pause_result(
        &draft.directory,
        &draft.manifest,
        Err(RecordingUploadError::Paused(
            PAUSED_DRAFT_MESSAGE.to_string(),
        )),
    );
    let message = result.unwrap_err().to_string();
    assert!(message.contains("Could not save the paused state"));
    assert!(message.contains("Recording files remain"));
    assert_eq!(
        draft.manifest.lock().unwrap().status,
        RETAINED_RECORDING_STATUS_PAUSED
    );
    assert_eq!(
        fs::read(
            draft
                .directory
                .join("segments/owner_mic/owner_mic-000000.wav")
        )
        .unwrap(),
        draft.bytes
    );
}

#[test]
fn paused_manifest_repair_keeps_pause_while_recovering_a_sealed_segment() {
    let draft = Draft::new(RECORDING_SEGMENT_STATUS_UPLOADED);
    let result: Result<(), _> = retain_pause_result(
        &draft.directory,
        &draft.manifest,
        Err(RecordingUploadError::Paused(
            PAUSED_DRAFT_MESSAGE.to_string(),
        )),
    );
    assert!(matches!(result, Err(RecordingUploadError::Paused(_))));
    let extra_path = draft
        .directory
        .join("segments/owner_mic/owner_mic-000001.wav");
    fs::write(&extra_path, &draft.bytes).unwrap();
    let repaired = repair_retained_recording_manifest(&draft.directory).unwrap();
    assert_eq!(repaired.status, RETAINED_RECORDING_STATUS_PAUSED);
    assert_eq!(repaired.upload_id.as_deref(), Some("original-upload"));
    assert_eq!(repaired.segments.len(), 2);
    assert_eq!(repaired.segments[1].sequence, 1);
    assert_eq!(
        read_retained_recording_manifest(&draft.directory)
            .unwrap()
            .status,
        RETAINED_RECORDING_STATUS_PAUSED
    );
    assert_eq!(fs::read(&extra_path).unwrap(), draft.bytes);
    assert_eq!(
        fs::read(draft.directory.join(&repaired.segments[0].file_name)).unwrap(),
        draft.bytes
    );
}

#[test]
fn unpaused_submission_still_marks_segments_submitted() {
    tauri::async_runtime::block_on(async {
        let api = ApiStub::new(vec![(
            "200 OK",
            serde_json::json!({"job": {"uploadId": "original-upload", "status": "queued"}})
                .to_string(),
        )]);
        let draft = Draft::new(RECORDING_SEGMENT_STATUS_UPLOADED);
        let result = submit_recording_manifest_with_token(
            &api.url,
            &draft.directory,
            &draft.manifest,
            "test-token",
        )
        .await
        .unwrap();
        assert_eq!(result.status, "queued");
        assert_eq!(
            draft.manifest.lock().unwrap().segments[0].status,
            RECORDING_SEGMENT_STATUS_SUBMITTED
        );
        assert_eq!(api.requests.load(Ordering::SeqCst), 1);
    });
}
