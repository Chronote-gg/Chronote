import argparse
import json
import os
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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


def load_records(meeting_dir: Path) -> List[Dict[str, Any]]:
    candidates = [
        meeting_dir / "transcriptions_classified_with_audio_and_full.json",
        meeting_dir / "transcriptions_classified_with_audio.json",
        meeting_dir / "transcriptions_classified.json",
    ]
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise SystemExit("No classified transcripts file found")


def load_observation_map(meeting_dir: Path) -> Dict[str, Optional[str]]:
    raw_path = meeting_dir / "transcriptions_raw.json"
    if not raw_path.exists():
        return {}
    raw_traces = json.loads(raw_path.read_text(encoding="utf-8"))
    mapping = {}
    for trace in raw_traces:
        trace_id = trace.get("id")
        observations = trace.get("observations") or []
        observation_id = observations[0] if observations else None
        if trace_id:
            mapping[trace_id] = observation_id
    return mapping


def parse_counts(raw: str, total: int) -> Dict[str, int]:
    if not raw:
        return {"hallucinated": 40, "unknown": 40, "legit": 20}
    parts = raw.split(",")
    counts: Dict[str, int] = {}
    for part in parts:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        counts[key] = int(value)
    if sum(counts.values()) != total:
        raise SystemExit("Counts must sum to sample size")
    return counts


def ensure_dataset(base_url: str, auth: Tuple[str, str], name: str) -> None:
    response = requests.post(
        f"{base_url.rstrip('/')}/api/public/v2/datasets",
        auth=auth,
        json={"name": name},
        timeout=30,
    )
    if response.status_code in (200, 201):
        return
    if response.status_code in (400, 409):
        return
    response.raise_for_status()


def create_dataset_item(
    base_url: str,
    auth: Tuple[str, str],
    payload: Dict[str, Any],
    retries: int = 5,
) -> None:
    delay = 0.5
    for attempt in range(retries):
        response = requests.post(
            f"{base_url.rstrip('/')}/api/public/dataset-items",
            auth=auth,
            json=payload,
            timeout=30,
        )
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            wait_seconds = float(retry_after) if retry_after else delay
            time.sleep(wait_seconds)
            delay = min(delay * 2, 10)
            continue
        if response.status_code in (200, 201):
            return
        if response.status_code in (400, 409):
            return
        response.raise_for_status()
    raise RuntimeError("rate_limited dataset-items")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a Langfuse dataset sample for manual labeling.",
    )
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--dataset-name", required=True)
    parser.add_argument("--sample-size", type=int, default=100)
    parser.add_argument("--counts", default="")
    parser.add_argument("--seed", type=int, default=26)
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
    records = load_records(meeting_dir)
    observation_map = load_observation_map(meeting_dir)

    buckets = {"hallucinated": [], "unknown": [], "legit": []}
    for record in records:
        bucket = record.get("classification")
        if bucket in buckets:
            buckets[bucket].append(record)

    random.seed(args.seed)
    counts = parse_counts(args.counts, args.sample_size)
    sample: List[Dict[str, Any]] = []
    for bucket, count in counts.items():
        available = buckets.get(bucket, [])
        if len(available) < count:
            raise SystemExit(f"Not enough records in {bucket}")
        sample.extend(random.sample(available, count))

    auth = (public_key, secret_key)
    ensure_dataset(base_url, auth, args.dataset_name)

    for record in sample:
        trace_id = record.get("trace_id")
        if not trace_id:
            continue
        dataset_item_id = f"{args.meeting_id}-{trace_id}"
        payload = {
            "datasetName": args.dataset_name,
            "input": {
                "text": record.get("output_text"),
                "traceId": trace_id,
                "traceUrlPath": record.get("trace_url_path"),
                "audioMediaId": record.get("audio_media_id"),
                "snippetTimestamp": record.get("snippet_timestamp"),
            },
            "metadata": {
                "classification": record.get("classification"),
                "classificationReasons": record.get("classification_reasons"),
                "transcriptionFlags": record.get("transcription_flags"),
                "logprobAvg": record.get("logprob_avg"),
                "logprobMin": record.get("logprob_min"),
                "noiseGateMetrics": record.get("noise_gate_metrics"),
                "audioMeanVolumeDb": record.get("audio_mean_volume_db"),
                "audioMaxVolumeDb": record.get("audio_max_volume_db"),
            },
            "sourceTraceId": trace_id,
            "sourceObservationId": observation_map.get(trace_id),
            "id": dataset_item_id,
            "status": "ACTIVE",
        }
        create_dataset_item(base_url, auth, payload)
        time.sleep(0.2)


if __name__ == "__main__":
    main()
