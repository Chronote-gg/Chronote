use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
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

#[derive(Clone, Copy, Default)]
pub struct CaptureSignalLevel {
    pub peak_level: f32,
    pub rms_level: f32,
    pub sample_count: u64,
    pub updated_at_epoch_ms: u64,
}

#[cfg(feature = "synthetic-audio")]
mod platform {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use hound::{SampleFormat, WavSpec, WavWriter};

    use super::{
        AudioDevice, AudioDeviceDirection, CaptureDirection, CaptureHandle, CaptureSignalLevel,
    };

    const SYNTHETIC_SAMPLE_RATE: u32 = 48_000;
    const SYNTHETIC_CHANNELS: u16 = 1;
    const SYNTHETIC_BITS_PER_SAMPLE: u16 = 32;
    const SYNTHETIC_CHUNK_SAMPLES: usize = 4_800;
    const SYNTHETIC_CHUNK_DELAY: Duration = Duration::from_millis(100);

    pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
        Ok(vec![
            AudioDevice {
                id: "synthetic-mic".to_string(),
                name: "Synthetic Microphone".to_string(),
                direction: AudioDeviceDirection::Input,
                is_default_communications: true,
            },
            AudioDevice {
                id: "synthetic-output".to_string(),
                name: "Synthetic System Output".to_string(),
                direction: AudioDeviceDirection::Output,
                is_default_communications: true,
            },
        ])
    }

    pub fn start_capture(
        direction: CaptureDirection,
        _device_id: Option<String>,
        output_path: PathBuf,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
    ) -> Result<CaptureHandle, String> {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(to_string)?;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name(format!(
                "chronote-synthetic-{}-capture",
                match direction {
                    CaptureDirection::Input => "mic",
                    CaptureDirection::Output => "system",
                }
            ))
            .spawn(move || synthetic_capture_loop(direction, output_path, thread_stop, signal_tx))
            .map_err(to_string)?;

        Ok(CaptureHandle { stop, thread })
    }

    fn synthetic_capture_loop(
        direction: CaptureDirection,
        output_path: PathBuf,
        stop: Arc<AtomicBool>,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
    ) -> Result<(), String> {
        let mut writer = WavWriter::create(
            output_path,
            WavSpec {
                channels: SYNTHETIC_CHANNELS,
                sample_rate: SYNTHETIC_SAMPLE_RATE,
                bits_per_sample: SYNTHETIC_BITS_PER_SAMPLE,
                sample_format: SampleFormat::Float,
            },
        )
        .map_err(to_string)?;
        let amplitude = match direction {
            CaptureDirection::Input => 0.42_f32,
            CaptureDirection::Output => 0.28_f32,
        };
        let mut total_samples = 0_u64;

        while !stop.load(Ordering::SeqCst) {
            write_synthetic_chunk(&mut writer, amplitude)?;
            total_samples = total_samples.saturating_add(SYNTHETIC_CHUNK_SAMPLES as u64);
            if let Some(signal_tx) = signal_tx.as_ref() {
                let _ = signal_tx.send(CaptureSignalLevel {
                    peak_level: amplitude,
                    rms_level: amplitude / 2.0_f32.sqrt(),
                    sample_count: total_samples,
                    updated_at_epoch_ms: now_epoch_millis(),
                });
            }
            thread::sleep(SYNTHETIC_CHUNK_DELAY);
        }

        if total_samples == 0 {
            write_synthetic_chunk(&mut writer, amplitude)?;
        }
        writer.flush().map_err(to_string)?;
        writer.finalize().map_err(to_string)
    }

    fn write_synthetic_chunk(
        writer: &mut WavWriter<std::io::BufWriter<std::fs::File>>,
        amplitude: f32,
    ) -> Result<(), String> {
        for index in 0..SYNTHETIC_CHUNK_SAMPLES {
            let phase = if index % 2 == 0 { 1.0 } else { -1.0 };
            writer.write_sample(amplitude * phase).map_err(to_string)?;
        }
        Ok(())
    }

    fn now_epoch_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn to_string(error: impl std::fmt::Display) -> String {
        error.to_string()
    }
}

#[cfg(all(windows, not(feature = "synthetic-audio")))]
mod platform {
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use hound::{SampleFormat, WavSpec, WavWriter};
    use wasapi::{
        Device, DeviceEnumerator, Direction, SampleType, StreamMode, WasapiError, WaveFormat,
    };

    use super::{
        AudioDevice, AudioDeviceDirection, CaptureDirection, CaptureHandle, CaptureSignalLevel,
    };

    const CAPTURE_SAMPLE_RATE: usize = 48_000;
    const CAPTURE_CHANNELS: usize = 1;
    const CAPTURE_BITS_PER_SAMPLE: usize = 32;
    const EVENT_WAIT_MS: u32 = 250;
    const SIGNAL_UPDATE_INTERVAL: Duration = Duration::from_millis(100);
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
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
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
            .spawn(move || {
                capture_to_wav(
                    direction,
                    device_id,
                    output_path,
                    thread_stop,
                    signal_tx,
                    ready_tx,
                )
            })
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
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        ready_tx: mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let init_result = initialize_capture(direction, device_id, &output_path, signal_tx);
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
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        sample_queue: VecDeque<u8>,
        block_align: usize,
    }

    fn initialize_capture(
        direction: CaptureDirection,
        device_id: Option<String>,
        output_path: &PathBuf,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
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
            signal_tx,
            sample_queue: VecDeque::with_capacity(
                100 * block_align * (1024 + 2 * buffer_frame_count as usize),
            ),
            block_align,
        })
    }

    fn capture_loop(capture: &mut ActiveWasapiCapture, stop: &AtomicBool) -> Result<(), String> {
        let mut signal = SignalAccumulator::default();
        let mut next_signal_update = Instant::now() + SIGNAL_UPDATE_INTERVAL;

        while !stop.load(Ordering::SeqCst) {
            match capture.event_handle.wait_for_event(EVENT_WAIT_MS) {
                Ok(()) => {}
                Err(WasapiError::EventTimeout) => continue,
                Err(error) => return Err(to_string(error)),
            }
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
                signal.observe(sample);
                capture.writer.write_sample(sample).map_err(to_string)?;
            }
            if Instant::now() >= next_signal_update {
                signal.publish(capture.signal_tx.as_ref());
                next_signal_update = Instant::now() + SIGNAL_UPDATE_INTERVAL;
            }
        }
        signal.publish(capture.signal_tx.as_ref());
        capture.writer.flush().map_err(to_string)
    }

    #[derive(Default)]
    struct SignalAccumulator {
        peak: f32,
        square_sum: f64,
        samples: u64,
        total_samples: u64,
    }

    impl SignalAccumulator {
        fn observe(&mut self, sample: f32) {
            let absolute = sample.abs();
            self.peak = self.peak.max(absolute);
            self.square_sum += f64::from(sample) * f64::from(sample);
            self.samples = self.samples.saturating_add(1);
        }

        fn publish(&mut self, signal_tx: Option<&mpsc::Sender<CaptureSignalLevel>>) {
            if self.samples == 0 {
                return;
            }

            let rms = (self.square_sum / self.samples as f64).sqrt() as f32;
            self.total_samples = self.total_samples.saturating_add(self.samples);
            if let Some(signal_tx) = signal_tx {
                let _ = signal_tx.send(CaptureSignalLevel {
                    peak_level: self.peak.clamp(0.0, 1.0),
                    rms_level: rms.clamp(0.0, 1.0),
                    sample_count: self.total_samples,
                    updated_at_epoch_ms: now_epoch_millis(),
                });
            }
            self.peak = 0.0;
            self.square_sum = 0.0;
            self.samples = 0;
        }
    }

    fn now_epoch_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }
}

#[cfg(all(not(windows), not(feature = "synthetic-audio")))]
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
        _signal_tx: Option<std::sync::mpsc::Sender<super::CaptureSignalLevel>>,
    ) -> Result<CaptureHandle, String> {
        Err("Chronote desktop recording is currently Windows-only.".to_string())
    }
}

pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    #[cfg(all(windows, not(feature = "synthetic-audio")))]
    {
        return std::thread::Builder::new()
            .name("chronote-audio-device-list".to_string())
            .spawn(platform::list_audio_devices)
            .map_err(|error| error.to_string())?
            .join()
            .map_err(|_| "Audio device enumeration thread panicked.".to_string())?;
    }

    #[cfg(any(feature = "synthetic-audio", not(windows)))]
    {
        platform::list_audio_devices()
    }
}

pub fn start_capture(
    direction: CaptureDirection,
    device_id: Option<String>,
    output_path: PathBuf,
    signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
) -> Result<CaptureHandle, String> {
    platform::start_capture(direction, device_id, output_path, signal_tx)
}
