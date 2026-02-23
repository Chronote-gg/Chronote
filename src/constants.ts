export const RECORD_SAMPLE_RATE = 48000; // Sample rate for recording and MP3 output
export const TRANSCRIBE_SAMPLE_RATE = 16000; // Sample rate for transcription input
export const CHANNELS = 2; // Stereo data
export const BYTES_PER_SAMPLE = 2; // 16 bit audio in this format
export const FRAME_SIZE = 960; // 20ms frame at 48kHz
export const FAST_SILENCE_THRESHOLD = 400; // ms of silence before fast transcription
export const SILENCE_THRESHOLD = 2000; // ms of silence before finalizing a snippet

export const MAX_SNIPPET_LENGTH = 60000; // maximum amount of time to put into a single snippet, to prevent our lossless audio buffer from getting too large

export const MINIMUM_TRANSCRIPTION_LENGTH = 0.3;

export const MAXIMUM_MEETING_DURATION = 7_200_000; // Max meeting duration of 2 hours
export const MAXIMUM_MEETING_DURATION_PRETTY = "2 hours"; // Max meeting duration of 2 hours

export const TRANSCRIPTION_MAX_RETRIES = 3;
export const TRANSCRIPTION_MAX_CONCURRENT = 2;
export const TRANSCRIPTION_MAX_QUEUE = 100;
export const TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES = 5;
export const TRANSCRIPTION_BREAK_DURATION = 10_000;
export const TRANSCRIPTION_RATE_MIN_TIME = 800; // Rate limit in minimum milliseconds between requests

export const LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT = 1;
export const LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME = 0;

export const GPT_MODEL_MAX_TOKENS = 128000;

export const TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE = 0.75; // If over 25% of lines were lost in cleanup, assume something went wrong and return original transcription

export const TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD = 0.15; // If transcription is less than 15% different from prompt, it's likely verbatim output
export const TRANSCRIPTION_LOGPROB_AVG_THRESHOLD = -1.2;
export const TRANSCRIPTION_LOGPROB_MIN_THRESHOLD = -2.5;
export const TRANSCRIPTION_HARD_SILENCE_DBFS = -60;
export const TRANSCRIPTION_RATE_MAX_SECONDS = 3;
export const TRANSCRIPTION_RATE_MIN_WORDS = 4;
export const TRANSCRIPTION_RATE_MIN_SYLLABLES = 8;
export const TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND = 7;
export const TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD = 0.2;
export const TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS = 12;
export const TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS = 2;
export const NOISE_GATE_ENABLED = true;
export const NOISE_GATE_WINDOW_MS = 20;
export const NOISE_GATE_PEAK_DBFS = -45;
export const NOISE_GATE_MIN_ACTIVE_WINDOWS = 2;
export const NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB = 15;
// Fixed percentile to keep the noise gate stable while defaults are tuned.
export const NOISE_GATE_NOISE_FLOOR_PERCENTILE = 0.2;
export const NOISE_GATE_APPLY_TO_FAST = true;
export const NOISE_GATE_APPLY_TO_SLOW = true;

// Contact feedback form limits
export const CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH = 4000; // Characters
export const CONTACT_FEEDBACK_MAX_IMAGES = 5;
export const CONTACT_FEEDBACK_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export const CONTACT_FEEDBACK_S3_PREFIX = "contact-feedback/";
export const CONTACT_FEEDBACK_RECAPTCHA_THRESHOLD = 0.5; // Minimum reCAPTCHA v3 score
export const CONTACT_FEEDBACK_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const CONTACT_FEEDBACK_RATE_LIMIT_MAX = 5; // Max submit calls per window
export const CONTACT_FEEDBACK_UPLOAD_URL_RATE_LIMIT_MAX = 15; // Max getUploadUrl calls per window (3x images)
export const CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS = 300; // 5 minutes
