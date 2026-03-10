import argparse
import json
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import requests


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
DEFAULT_BASE_URL = "https://cloud.langfuse.com"


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


def fetch_media_url(
    base_url: str,
    public_key: str,
    secret_key: str,
    media_id: str,
    retries: int = 5,
) -> str:
    delay = 1.0
    for attempt in range(retries):
        response = requests.get(
            f"{base_url.rstrip('/')}/api/public/media/{media_id}",
            auth=(public_key, secret_key),
            timeout=60,
        )
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            wait_seconds = float(retry_after) if retry_after else delay
            time.sleep(wait_seconds)
            delay = min(delay * 2, 30)
            continue
        response.raise_for_status()
        payload = response.json()
        return payload["url"]
    raise RuntimeError(f"rate_limited media_id={media_id}")


def download_media(url: str, target: Path) -> None:
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    target.write_bytes(response.content)


def parse_volume(output: str) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    mean_match = re.search(r"mean_volume:\s*([-\w.]+) dB", output)
    max_match = re.search(r"max_volume:\s*([-\w.]+) dB", output)
    mean_value = mean_match.group(1) if mean_match else None
    max_value = max_match.group(1) if max_match else None

    status = None
    mean_db: Optional[float]
    max_db: Optional[float]
    if mean_value is None:
        mean_db = None
    elif mean_value == "-inf":
        mean_db = None
        status = "silence"
    else:
        mean_db = float(mean_value)
    if max_value is None:
        max_db = None
    elif max_value == "-inf":
        max_db = None
        status = status or "silence"
    else:
        max_db = float(max_value)

    return mean_db, max_db, status


def compute_volume(
    file_path: Path,
) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(file_path),
            "-filter:a",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return parse_volume(result.stderr)


def process_media_id(
    media_id: str,
    base_url: str,
    public_key: str,
    secret_key: str,
    cache_dir: Path,
    request_delay: float,
) -> Tuple[str, Dict[str, Any]]:
    target = cache_dir / f"{media_id}.mp3"
    if not target.exists():
        url = fetch_media_url(base_url, public_key, secret_key, media_id)
        download_media(url, target)
        if request_delay > 0:
            time.sleep(request_delay)
    mean_db, max_db, status = compute_volume(target)
    return media_id, {
        "audio_mean_volume_db": mean_db,
        "audio_max_volume_db": max_db,
        "audio_volume_status": status,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute mean volume (dB) for Langfuse audio media.",
    )
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--retry-errors", action="store_true")
    parser.add_argument("--min-delay", type=float, default=0.0)
    parser.add_argument("--base-url", default="")
    args = parser.parse_args()

    load_env(ENV_PATH)
    public_key = os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    base_url = (
        args.base_url or os.getenv("LANGFUSE_BASE_URL", "").strip() or DEFAULT_BASE_URL
    )
    if not public_key or not secret_key:
        raise SystemExit("Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY in env.")

    meeting_dir = Path("analysis/hallucination-audit") / args.meeting_id
    input_path = meeting_dir / "transcriptions_classified.json"
    if not input_path.exists():
        raise SystemExit(f"Missing {input_path}")

    records = json.loads(input_path.read_text(encoding="utf-8"))
    seen = set()
    media_ids = []
    for record in records:
        media_id = record.get("audio_media_id")
        if not media_id or media_id in seen:
            continue
        seen.add(media_id)
        media_ids.append(media_id)

    if args.offset and args.offset > 0:
        media_ids = media_ids[args.offset :]
    if args.limit and args.limit > 0:
        media_ids = media_ids[: args.limit]

    cache_dir = Path("analysis/hallucination-audit/audio_cache")
    cache_dir.mkdir(parents=True, exist_ok=True)

    metrics_path = meeting_dir / "audio_volume_metrics.json"
    metrics: Dict[str, Dict[str, Any]] = {}
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))

    remaining = []
    for media_id in media_ids:
        if media_id not in metrics:
            remaining.append(media_id)
            continue
        if args.retry_errors:
            status = metrics[media_id].get("audio_volume_status") or ""
            if isinstance(status, str) and status.startswith("error:"):
                remaining.append(media_id)
    if remaining:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    process_media_id,
                    media_id,
                    base_url,
                    public_key,
                    secret_key,
                    cache_dir,
                    args.min_delay,
                ): media_id
                for media_id in remaining
            }
            completed = 0
            for future in as_completed(futures):
                media_id = futures[future]
                try:
                    media_id, data = future.result()
                    metrics[media_id] = data
                except Exception as exc:
                    metrics[media_id] = {
                        "audio_mean_volume_db": None,
                        "audio_max_volume_db": None,
                        "audio_volume_status": f"error:{exc}",
                    }
                completed += 1
                if completed % 25 == 0:
                    metrics_path.write_text(
                        json.dumps(metrics, indent=2),
                        encoding="utf-8",
                    )
                time.sleep(0.05)
    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    for record in records:
        media_id = record.get("audio_media_id")
        data = metrics.get(media_id, {}) if media_id else {}
        record.update(data)

    output_json = meeting_dir / "transcriptions_classified_with_audio.json"
    output_json.write_text(json.dumps(records, indent=2), encoding="utf-8")

    output_csv = meeting_dir / "transcriptions_classified_with_audio.csv"
    fields = list(records[0].keys()) if records else []
    if records:
        with output_csv.open("w", encoding="utf-8", newline="") as handle:
            handle.write(",".join(fields) + "\n")
            for record in records:
                row = []
                for field in fields:
                    value = record.get(field)
                    if isinstance(value, list):
                        value = "|".join(str(item) for item in value)
                    elif isinstance(value, dict):
                        value = json.dumps(value)
                    elif value is None:
                        value = ""
                    text = str(value)
                    if "," in text or "\n" in text or '"' in text:
                        text = '"' + text.replace('"', '""') + '"'
                    row.append(text)
                handle.write(",".join(row) + "\n")


if __name__ == "__main__":
    main()
