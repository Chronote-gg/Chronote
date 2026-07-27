import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional

import requests


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def segment_audio(input_path: Path, segment_dir: Path, seconds: int) -> List[Path]:
    segment_dir.mkdir(parents=True, exist_ok=True)
    if list(segment_dir.glob("segment_*.mp3")):
        return sorted(segment_dir.glob("segment_*.mp3"))
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "64k",
            "-f",
            "segment",
            "-segment_time",
            str(seconds),
            "-reset_timestamps",
            "1",
            str(segment_dir / "segment_%03d.mp3"),
        ],
        check=True,
    )
    return sorted(segment_dir.glob("segment_*.mp3"))


def transcribe_segment(
    api_key: str, file_path: Path, model: str
) -> Dict[str, Optional[str]]:
    with file_path.open("rb") as handle:
        response = requests.post(
            OPENAI_TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": handle},
            data={
                "model": model,
                "response_format": "json",
                "temperature": "0",
            },
            timeout=600,
        )
    if response.status_code >= 400:
        return {"error": response.text}
    payload = response.json()
    return {"text": payload.get("text")}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Transcribe full meeting audio using OpenAI.",
    )
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--audio", default="")
    parser.add_argument("--chunk-seconds", type=int, default=600)
    parser.add_argument("--model", default="gpt-4o-transcribe")
    parser.add_argument("--min-delay", type=float, default=1.0)
    args = parser.parse_args()

    load_env(ENV_PATH)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("Missing OPENAI_API_KEY in env")

    meeting_dir = Path("analysis/hallucination-audit") / args.meeting_id
    meeting_dir.mkdir(parents=True, exist_ok=True)
    audio_path = Path(args.audio) if args.audio else meeting_dir / "audio_combined.mp3"
    if not audio_path.exists():
        raise SystemExit(f"Missing audio file {audio_path}")

    segment_dir = meeting_dir / "full_audio_segments"
    segments = segment_audio(audio_path, segment_dir, args.chunk_seconds)

    results = []
    for index, segment in enumerate(segments):
        start_seconds = index * args.chunk_seconds
        end_seconds = (index + 1) * args.chunk_seconds
        result = transcribe_segment(api_key, segment, args.model)
        results.append(
            {
                "index": index,
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "file": str(segment),
                "text": result.get("text"),
                "error": result.get("error"),
            }
        )
        time.sleep(args.min_delay)

    (meeting_dir / "full_transcript_segments.json").write_text(
        json.dumps(results, indent=2),
        encoding="utf-8",
    )
    combined = "\n".join(item["text"] or "" for item in results).strip()
    (meeting_dir / "full_transcript.txt").write_text(combined, encoding="utf-8")


if __name__ == "__main__":
    main()
