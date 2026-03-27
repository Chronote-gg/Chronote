import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Optional

import boto3


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


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


def get_audio_key(meeting_dir: Path) -> str:
    match_path = meeting_dir / "meeting_history_match.json"
    if not match_path.exists():
        raise SystemExit(f"Missing {match_path}")
    payload = json.loads(match_path.read_text(encoding="utf-8"))
    if not payload:
        raise SystemExit("meeting_history_match.json is empty")
    audio_key = payload[0].get("audioS3Key")
    if not audio_key:
        raise SystemExit("audioS3Key missing in meeting_history_match.json")
    return audio_key


def get_duration_seconds(file_path: Path) -> Optional[float]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(file_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    value = result.stdout.strip()
    try:
        return float(value)
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download full meeting audio from S3.",
    )
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--bucket", default="")
    args = parser.parse_args()

    load_env(ENV_PATH)
    bucket = args.bucket or os.getenv("TRANSCRIPTS_BUCKET")
    if not bucket:
        raise SystemExit("Missing TRANSCRIPTS_BUCKET in env or --bucket")

    meeting_dir = Path("analysis/hallucination-audit") / args.meeting_id
    meeting_dir.mkdir(parents=True, exist_ok=True)
    audio_key = get_audio_key(meeting_dir)

    target = meeting_dir / "audio_combined.mp3"
    if not target.exists():
        client = boto3.client("s3", region_name=os.getenv("AWS_REGION", "us-east-1"))
        client.download_file(bucket, audio_key, str(target))

    duration = get_duration_seconds(target)
    metadata = {
        "bucket": bucket,
        "audioS3Key": audio_key,
        "local_path": str(target),
        "file_size_bytes": target.stat().st_size,
        "duration_seconds": duration,
    }
    (meeting_dir / "full_audio_metadata.json").write_text(
        json.dumps(metadata, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
