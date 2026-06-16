use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hound::{WavSpec, WavWriter};
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

#[derive(Clone)]
pub struct CaptureSegment {
    pub sequence: u32,
    pub path: PathBuf,
    pub started_at_epoch_ms: u64,
    pub ended_at_epoch_ms: u64,
    pub duration_millis: u64,
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

type WavFileWriter = WavWriter<std::io::BufWriter<std::fs::File>>;

struct SegmentedWavWriter {
    output_dir: PathBuf,
    source_id: String,
    spec: WavSpec,
    segment_sample_limit: u32,
    sequence: u32,
    current_started_at_epoch_ms: u64,
    writer: Option<WavFileWriter>,
    tmp_path: PathBuf,
    segment_tx: mpsc::Sender<CaptureSegment>,
}

impl SegmentedWavWriter {
    fn create(
        output_dir: PathBuf,
        source_id: String,
        spec: WavSpec,
        segment_duration: Duration,
        segment_tx: mpsc::Sender<CaptureSegment>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&output_dir).map_err(to_string)?;
        let segment_millis = segment_duration.as_millis().max(1);
        let segment_sample_limit = ((u128::from(spec.sample_rate) * segment_millis) / 1000)
            .max(1)
            .min(u128::from(u32::MAX)) as u32;
        let mut writer = Self {
            output_dir,
            source_id,
            spec,
            segment_sample_limit,
            sequence: 0,
            current_started_at_epoch_ms: now_epoch_millis(),
            writer: None,
            tmp_path: PathBuf::new(),
            segment_tx,
        };
        writer.start_segment(now_epoch_millis())?;
        Ok(writer)
    }

    fn write_sample(&mut self, sample: f32) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| "Segment writer was not initialized.".to_string())?;
        writer.write_sample(sample).map_err(to_string)?;
        if writer.duration() >= self.segment_sample_limit {
            self.finish_segment(now_epoch_millis(), true)?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.as_mut() {
            writer.flush().map_err(to_string)?;
        }
        Ok(())
    }

    fn finalize(mut self) -> Result<(), String> {
        self.finish_segment(now_epoch_millis(), false)
    }

    fn start_segment(&mut self, started_at_epoch_ms: u64) -> Result<(), String> {
        self.current_started_at_epoch_ms = started_at_epoch_ms;
        self.tmp_path = self
            .output_dir
            .join(format!("{}-{:06}.wav.part", self.source_id, self.sequence));
        self.writer = Some(WavWriter::create(&self.tmp_path, self.spec).map_err(to_string)?);
        Ok(())
    }

    fn finish_segment(&mut self, ended_at_epoch_ms: u64, start_next: bool) -> Result<(), String> {
        let Some(writer) = self.writer.take() else {
            return Ok(());
        };
        let sample_count = u64::from(writer.duration());
        if sample_count == 0 {
            drop(writer);
            let _ = fs::remove_file(&self.tmp_path);
            if start_next {
                self.start_segment(ended_at_epoch_ms)?;
            }
            return Ok(());
        }
        writer.finalize().map_err(to_string)?;
        let final_path = self
            .output_dir
            .join(format!("{}-{:06}.wav", self.source_id, self.sequence));
        fs::rename(&self.tmp_path, &final_path).map_err(to_string)?;
        let duration_millis = ((sample_count as u128 * 1000) / u128::from(self.spec.sample_rate))
            .min(u128::from(u64::MAX)) as u64;
        let _ = self.segment_tx.send(CaptureSegment {
            sequence: self.sequence,
            path: final_path,
            started_at_epoch_ms: self.current_started_at_epoch_ms,
            ended_at_epoch_ms: ended_at_epoch_ms.max(self.current_started_at_epoch_ms),
            duration_millis,
        });
        self.sequence = self.sequence.saturating_add(1);
        if start_next {
            self.start_segment(ended_at_epoch_ms)?;
        }
        Ok(())
    }
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

#[cfg(feature = "synthetic-audio")]
mod platform {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    use hound::{SampleFormat, WavSpec};

    use super::{
        AudioDevice, AudioDeviceDirection, CaptureDirection, CaptureHandle, CaptureSegment,
        CaptureSignalLevel, SegmentedWavWriter,
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
        output_dir: PathBuf,
        source_id: String,
        segment_duration: Duration,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        segment_tx: mpsc::Sender<CaptureSegment>,
    ) -> Result<CaptureHandle, String> {
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
            .spawn(move || {
                synthetic_capture_loop(
                    direction,
                    output_dir,
                    source_id,
                    segment_duration,
                    thread_stop,
                    signal_tx,
                    segment_tx,
                )
            })
            .map_err(to_string)?;

        Ok(CaptureHandle { stop, thread })
    }

    fn synthetic_capture_loop(
        direction: CaptureDirection,
        output_dir: PathBuf,
        source_id: String,
        segment_duration: Duration,
        stop: Arc<AtomicBool>,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        segment_tx: mpsc::Sender<CaptureSegment>,
    ) -> Result<(), String> {
        let mut writer = SegmentedWavWriter::create(
            output_dir,
            source_id,
            WavSpec {
                channels: SYNTHETIC_CHANNELS,
                sample_rate: SYNTHETIC_SAMPLE_RATE,
                bits_per_sample: SYNTHETIC_BITS_PER_SAMPLE,
                sample_format: SampleFormat::Float,
            },
            segment_duration,
            segment_tx,
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
                    updated_at_epoch_ms: super::now_epoch_millis(),
                });
            }
            thread::sleep(SYNTHETIC_CHUNK_DELAY);
        }

        if total_samples == 0 {
            write_synthetic_chunk(&mut writer, amplitude)?;
        }
        writer.flush()?;
        writer.finalize()
    }

    fn write_synthetic_chunk(
        writer: &mut SegmentedWavWriter,
        amplitude: f32,
    ) -> Result<(), String> {
        for index in 0..SYNTHETIC_CHUNK_SAMPLES {
            let phase = if index % 2 == 0 { 1.0 } else { -1.0 };
            writer.write_sample(amplitude * phase)?;
        }
        Ok(())
    }
}

#[cfg(all(windows, not(feature = "synthetic-audio")))]
mod platform {
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    use hound::{SampleFormat, WavSpec};
    use wasapi::{
        Device, DeviceEnumerator, Direction, SampleType, StreamMode, WasapiError, WaveFormat,
    };

    use super::{
        AudioDevice, AudioDeviceDirection, CaptureDirection, CaptureHandle, CaptureSegment,
        CaptureSignalLevel, SegmentedWavWriter,
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
        output_dir: PathBuf,
        source_id: String,
        segment_duration: Duration,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        segment_tx: mpsc::Sender<CaptureSegment>,
    ) -> Result<CaptureHandle, String> {
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
                    output_dir,
                    source_id,
                    segment_duration,
                    thread_stop,
                    signal_tx,
                    segment_tx,
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
        output_dir: PathBuf,
        source_id: String,
        segment_duration: Duration,
        stop: Arc<AtomicBool>,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        segment_tx: mpsc::Sender<CaptureSegment>,
        ready_tx: mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let init_result = initialize_capture(
            direction,
            device_id,
            output_dir,
            source_id,
            segment_duration,
            signal_tx,
            segment_tx,
        );
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
        let finalize_result = capture.writer.finalize();
        result.and(stop_result).and(finalize_result)
    }

    struct ActiveWasapiCapture {
        audio_client: wasapi::AudioClient,
        capture_client: wasapi::AudioCaptureClient,
        event_handle: wasapi::Handle,
        writer: SegmentedWavWriter,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        sample_queue: VecDeque<u8>,
        block_align: usize,
    }

    fn initialize_capture(
        direction: CaptureDirection,
        device_id: Option<String>,
        output_dir: PathBuf,
        source_id: String,
        segment_duration: Duration,
        signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        segment_tx: mpsc::Sender<CaptureSegment>,
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
        let writer = SegmentedWavWriter::create(
            output_dir,
            source_id,
            WavSpec {
                channels: CAPTURE_CHANNELS as u16,
                sample_rate: CAPTURE_SAMPLE_RATE as u32,
                bits_per_sample: CAPTURE_BITS_PER_SAMPLE as u16,
                sample_format: SampleFormat::Float,
            },
            segment_duration,
            segment_tx,
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
                capture.writer.write_sample(sample)?;
            }
            if Instant::now() >= next_signal_update {
                signal.publish(capture.signal_tx.as_ref());
                capture.writer.flush()?;
                next_signal_update = Instant::now() + SIGNAL_UPDATE_INTERVAL;
            }
        }
        signal.publish(capture.signal_tx.as_ref());
        capture.writer.flush()
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
                    updated_at_epoch_ms: super::now_epoch_millis(),
                });
            }
            self.peak = 0.0;
            self.square_sum = 0.0;
            self.samples = 0;
        }
    }
}

#[cfg(all(not(windows), not(feature = "synthetic-audio")))]
mod platform {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    use super::{AudioDevice, CaptureDirection, CaptureHandle, CaptureSegment, CaptureSignalLevel};

    pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
        Ok(Vec::new())
    }

    pub fn start_capture(
        _direction: CaptureDirection,
        _device_id: Option<String>,
        _output_dir: PathBuf,
        _source_id: String,
        _segment_duration: Duration,
        _signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
        _segment_tx: mpsc::Sender<CaptureSegment>,
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
    output_dir: PathBuf,
    source_id: String,
    segment_duration: Duration,
    signal_tx: Option<mpsc::Sender<CaptureSignalLevel>>,
    segment_tx: mpsc::Sender<CaptureSegment>,
) -> Result<CaptureHandle, String> {
    platform::start_capture(
        direction,
        device_id,
        output_dir,
        source_id,
        segment_duration,
        signal_tx,
        segment_tx,
    )
}
