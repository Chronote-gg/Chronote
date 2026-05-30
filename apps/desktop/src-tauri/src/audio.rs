use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub direction: AudioDeviceDirection,
    pub is_default_communications: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioDeviceDirection {
    Input,
    Output,
}

#[derive(Clone, Copy)]
pub enum CaptureDirection {
    Input,
    Output,
}

pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<(), String>>,
}

impl CaptureHandle {
    pub fn stop(self) -> Result<(), String> {
        self.stop.store(true, Ordering::SeqCst);
        self.thread
            .join()
            .map_err(|_| "Audio capture thread panicked.".to_string())?
    }
}

#[cfg(windows)]
mod platform {
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    use hound::{SampleFormat, WavSpec, WavWriter};
    use wasapi::{Device, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    use super::{AudioDevice, AudioDeviceDirection, CaptureDirection, CaptureHandle};

    const CAPTURE_SAMPLE_RATE: usize = 48_000;
    const CAPTURE_CHANNELS: usize = 1;
    const CAPTURE_BITS_PER_SAMPLE: usize = 32;
    const EVENT_WAIT_MS: u32 = 250;
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

    pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
        wasapi::initialize_mta().ok().map_err(to_string)?;
        let enumerator = DeviceEnumerator::new().map_err(to_string)?;
        let mut devices = Vec::new();
        devices.extend(list_direction_devices(
            &enumerator,
            Direction::Capture,
            AudioDeviceDirection::Input,
        )?);
        devices.extend(list_direction_devices(
            &enumerator,
            Direction::Render,
            AudioDeviceDirection::Output,
        )?);
        Ok(devices)
    }

    pub fn start_capture(
        direction: CaptureDirection,
        device_id: Option<String>,
        output_path: PathBuf,
    ) -> Result<CaptureHandle, String> {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(to_string)?;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name(format!(
                "chronote-{}-capture",
                match direction {
                    CaptureDirection::Input => "mic",
                    CaptureDirection::Output => "system",
                }
            ))
            .spawn(move || capture_to_wav(direction, device_id, output_path, thread_stop, ready_tx))
            .map_err(to_string)?;

        match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(CaptureHandle { stop, thread }),
            Ok(Err(error)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                Err("Audio capture did not start within 5 seconds.".to_string())
            }
        }
    }

    fn to_string(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    fn list_direction_devices(
        enumerator: &DeviceEnumerator,
        direction: Direction,
        device_direction: AudioDeviceDirection,
    ) -> Result<Vec<AudioDevice>, String> {
        let default_id = enumerator
            .get_default_device(&direction)
            .ok()
            .and_then(|device| device.get_id().ok());
        let collection = enumerator
            .get_device_collection(&direction)
            .map_err(to_string)?;
        let mut devices = Vec::new();

        for device in &collection {
            let device = device.map_err(to_string)?;
            let id = device.get_id().map_err(to_string)?;
            let name = device.get_friendlyname().map_err(to_string)?;
            devices.push(AudioDevice {
                is_default_communications: default_id
                    .as_ref()
                    .map(|default_id| default_id == &id)
                    .unwrap_or(false),
                id,
                name,
                direction: device_direction.clone(),
            });
        }

        Ok(devices)
    }

    fn resolve_direction(direction: CaptureDirection) -> Direction {
        match direction {
            CaptureDirection::Input => Direction::Capture,
            CaptureDirection::Output => Direction::Render,
        }
    }

    fn resolve_device(
        enumerator: &DeviceEnumerator,
        direction: Direction,
        device_id: Option<String>,
    ) -> Result<Device, String> {
        let Some(device_id) = device_id.filter(|id| !id.trim().is_empty()) else {
            return enumerator.get_default_device(&direction).map_err(to_string);
        };

        for device in &enumerator
            .get_device_collection(&direction)
            .map_err(to_string)?
        {
            let device = device.map_err(to_string)?;
            if device.get_id().map_err(to_string)? == device_id {
                return Ok(device);
            }
        }

        Err("Selected audio device is no longer available.".to_string())
    }

    fn capture_to_wav(
        direction: CaptureDirection,
        device_id: Option<String>,
        output_path: PathBuf,
        stop: Arc<AtomicBool>,
        ready_tx: mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let init_result = initialize_capture(direction, device_id, &output_path);
        let Ok(mut capture) = init_result else {
            let error = init_result
                .err()
                .unwrap_or_else(|| "Audio capture failed.".to_string());
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        };

        let _ = ready_tx.send(Ok(()));
        let result = capture_loop(&mut capture, &stop);
        let stop_result = capture.audio_client.stop_stream().map_err(to_string);
        let finalize_result = capture.writer.finalize().map_err(to_string);
        result.and(stop_result).and(finalize_result)
    }

    struct ActiveWasapiCapture {
        audio_client: wasapi::AudioClient,
        capture_client: wasapi::AudioCaptureClient,
        event_handle: wasapi::Handle,
        writer: WavWriter<std::io::BufWriter<std::fs::File>>,
        sample_queue: VecDeque<u8>,
        block_align: usize,
    }

    fn initialize_capture(
        direction: CaptureDirection,
        device_id: Option<String>,
        output_path: &PathBuf,
    ) -> Result<ActiveWasapiCapture, String> {
        wasapi::initialize_mta().ok().map_err(to_string)?;
        let enumerator = DeviceEnumerator::new().map_err(to_string)?;
        let device = resolve_device(&enumerator, resolve_direction(direction), device_id)?;
        let mut audio_client = device.get_iaudioclient().map_err(to_string)?;
        let wave_format = WaveFormat::new(
            CAPTURE_BITS_PER_SAMPLE,
            CAPTURE_BITS_PER_SAMPLE,
            &SampleType::Float,
            CAPTURE_SAMPLE_RATE,
            CAPTURE_CHANNELS,
            None,
        );
        let block_align = wave_format.get_blockalign() as usize;
        let (_default_period, min_period) = audio_client.get_device_period().map_err(to_string)?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_period,
        };
        audio_client
            .initialize_client(&wave_format, &Direction::Capture, &mode)
            .map_err(to_string)?;
        let event_handle = audio_client.set_get_eventhandle().map_err(to_string)?;
        let buffer_frame_count = audio_client.get_buffer_size().map_err(to_string)?;
        let capture_client = audio_client.get_audiocaptureclient().map_err(to_string)?;
        let writer = WavWriter::create(
            output_path,
            WavSpec {
                channels: CAPTURE_CHANNELS as u16,
                sample_rate: CAPTURE_SAMPLE_RATE as u32,
                bits_per_sample: CAPTURE_BITS_PER_SAMPLE as u16,
                sample_format: SampleFormat::Float,
            },
        )
        .map_err(to_string)?;
        audio_client.start_stream().map_err(to_string)?;

        Ok(ActiveWasapiCapture {
            audio_client,
            capture_client,
            event_handle,
            writer,
            sample_queue: VecDeque::with_capacity(
                100 * block_align * (1024 + 2 * buffer_frame_count as usize),
            ),
            block_align,
        })
    }

    fn capture_loop(capture: &mut ActiveWasapiCapture, stop: &AtomicBool) -> Result<(), String> {
        while !stop.load(Ordering::SeqCst) {
            capture
                .event_handle
                .wait_for_event(EVENT_WAIT_MS)
                .map_err(to_string)?;
            capture
                .capture_client
                .read_from_device_to_deque(&mut capture.sample_queue)
                .map_err(to_string)?;
            while capture.sample_queue.len() >= capture.block_align {
                let bytes = [
                    capture.sample_queue.pop_front().unwrap_or_default(),
                    capture.sample_queue.pop_front().unwrap_or_default(),
                    capture.sample_queue.pop_front().unwrap_or_default(),
                    capture.sample_queue.pop_front().unwrap_or_default(),
                ];
                let sample = f32::from_le_bytes(bytes).clamp(-1.0, 1.0);
                capture.writer.write_sample(sample).map_err(to_string)?;
            }
        }
        capture.writer.flush().map_err(to_string)
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::thread;

    use super::{AudioDevice, CaptureDirection, CaptureHandle};

    pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
        Ok(Vec::new())
    }

    pub fn start_capture(
        _direction: CaptureDirection,
        _device_id: Option<String>,
        _output_path: PathBuf,
    ) -> Result<CaptureHandle, String> {
        Err("Chronote desktop recording is currently Windows-only.".to_string())
    }
}

#[cfg(windows)]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    std::thread::Builder::new()
        .name("chronote-audio-device-list".to_string())
        .spawn(platform::list_audio_devices)
        .map_err(|error| error.to_string())?
        .join()
        .map_err(|_| "Audio device enumeration thread panicked.".to_string())?
}

#[cfg(not(windows))]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    platform::list_audio_devices()
}

pub fn start_capture(
    direction: CaptureDirection,
    device_id: Option<String>,
    output_path: PathBuf,
) -> Result<CaptureHandle, String> {
    platform::start_capture(direction, device_id, output_path)
}
