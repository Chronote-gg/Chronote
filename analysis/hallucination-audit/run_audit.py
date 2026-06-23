import argparse
import datetime as dt
import json
import os
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
DEFAULT_WINDOW = "19:00-20:00"
DEFAULT_TZ_OFFSET = "-05:00"
DEFAULT_NAME = "transcription"
DEFAULT_FIELDS = "core,io"
DEFAULT_LIMIT = 100
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


def get_ny_dates() -> Tuple[str, str]:
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("America/New_York")
        now_ny = dt.datetime.now(tz)
        today = now_ny.date()
        yesterday = today - dt.timedelta(days=1)
        return today.isoformat(), yesterday.isoformat()
    except Exception:
        today = dt.date.today().isoformat()
        yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        return today, yesterday


def window_to_range(date_str: str, window: str, tz_offset: str) -> Tuple[str, str]:
    if "-" not in window:
        raise ValueError("window must be in HH:MM-HH:MM format")
    start_time, end_time = window.split("-", 1)
    start_time = start_time.strip()
    end_time = end_time.strip()
    if len(start_time) == 5:
        start_time = f"{start_time}:00"
    if len(end_time) == 5:
        end_time = f"{end_time}:00"
    start_ts = f"{date_str}T{start_time}{tz_offset}"
    end_ts = f"{date_str}T{end_time}{tz_offset}"
    return start_ts, end_ts


def parse_audio_media_id(audio_input: Any) -> Optional[str]:
    if not isinstance(audio_input, str):
        return None
    match = re.search(r"id=([^|]+)", audio_input)
    if not match:
        return None
    return match.group(1)


def normalize_text(value: str) -> str:
    lowered = value.lower()
    stripped = re.sub(r"[^a-z0-9\s]", " ", lowered)
    collapsed = re.sub(r"\s+", " ", stripped).strip()
    return collapsed


def levenshtein_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            insert_cost = current[j - 1] + 1
            delete_cost = previous[j] + 1
            replace_cost = previous[j - 1] + (0 if ca == cb else 1)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    return previous[-1]


def build_duplicate_groups(records: List[Dict[str, Any]]) -> Dict[str, int]:
    groups: Dict[str, int] = {}
    group_id = 1
    occurrences: Dict[str, List[int]] = defaultdict(list)
    for index, record in enumerate(records):
        text = record.get("normalized_text")
        if not text:
            continue
        occurrences[text].append(index)
    for indices in occurrences.values():
        if len(indices) < 2:
            continue
        for idx in indices:
            groups[records[idx]["trace_id"]] = group_id
        group_id += 1
    return groups


def build_near_duplicate_groups(records: List[Dict[str, Any]]) -> Dict[str, int]:
    candidates: List[Tuple[str, str]] = []
    for record in records:
        norm = record.get("normalized_text")
        if not norm or len(norm) < 12:
            continue
        candidates.append((record["trace_id"], norm))
    if not candidates:
        return {}

    buckets: Dict[Tuple[int, str], List[Tuple[str, str]]] = defaultdict(list)
    for trace_id, norm in candidates:
        length_bucket = len(norm) // 20
        prefix = norm[:5]
        buckets[(length_bucket, prefix)].append((trace_id, norm))

    parent: Dict[str, str] = {}

    def find(x: str) -> str:
        root = parent.get(x, x)
        if root != x:
            parent[x] = find(root)
        return parent.get(x, x)

    def union(a: str, b: str) -> None:
        ra = find(a)
        rb = find(b)
        if ra != rb:
            parent[rb] = ra

    for items in buckets.values():
        if len(items) < 2:
            continue
        if len(items) > 200:
            continue
        for i in range(len(items)):
            trace_a, text_a = items[i]
            for j in range(i + 1, len(items)):
                trace_b, text_b = items[j]
                if abs(len(text_a) - len(text_b)) > 20:
                    continue
                dist = levenshtein_distance(text_a, text_b)
                ratio = dist / max(len(text_a), len(text_b))
                if ratio <= 0.2:
                    union(trace_a, trace_b)

    groups: Dict[str, int] = {}
    group_id = 1
    clusters: Dict[str, List[str]] = defaultdict(list)
    for trace_id, _ in candidates:
        root = find(trace_id)
        clusters[root].append(trace_id)
    for trace_ids in clusters.values():
        if len(trace_ids) < 2:
            continue
        for trace_id in trace_ids:
            groups[trace_id] = group_id
        group_id += 1
    return groups


def classify_record(record: Dict[str, Any]) -> Tuple[str, List[str]]:
    hallucination_reasons: List[str] = []
    suspicious_reasons: List[str] = []
    text = record.get("output_text", "")
    text_trimmed = text.strip()
    flags = set(record.get("transcription_flags") or [])
    prompt_echo_detected = bool(record.get("prompt_echo_detected"))
    suppressed = bool(record.get("suppressed"))
    quiet_audio = bool(record.get("quiet_audio"))
    hard_silence = bool(record.get("hard_silence_detected"))
    rate_mismatch = bool(record.get("rate_mismatch_detected"))
    avg_logprob = record.get("logprob_avg")
    min_logprob = record.get("logprob_min")

    contains_timestamp = bool(re.search(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", text))
    contains_date = bool(re.search(r"\b\d{4}-\d{2}-\d{2}\b", text))
    contains_bracket_time = bool(re.search(r"\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*\]", text))
    contains_vket = bool(re.search(r"\bv\s*cat\b|\bvket\b", text, re.IGNORECASE))
    contains_prompt_tokens = bool(
        re.search(
            r"(attendees:|server name:|channel:|dictionary terms|transcript instruction|<glossary>|bot names)",
            text,
            re.IGNORECASE,
        )
    )
    contains_bot_names = bool(
        re.search(
            r"(chronote|meeting notes bot|meetingnotesbot|keeper of voices)",
            text,
            re.IGNORECASE,
        )
    )

    if not text_trimmed:
        if (
            prompt_echo_detected
            or "prompt_echo_substring" in flags
            or "suppressed_prompt_echo" in flags
        ):
            hallucination_reasons.append("prompt_echo_detected")
            return "hallucinated", hallucination_reasons
        suspicious_reasons.append("no_output")
        return "unknown", suspicious_reasons

    if contains_prompt_tokens:
        suspicious_reasons.append("contains_prompt_tokens")
    if rate_mismatch and text_trimmed:
        hallucination_reasons.append("rate_mismatch_nonempty")
    if contains_vket:
        hallucination_reasons.append("contains_vket")
    if (
        prompt_echo_detected
        or "prompt_echo_substring" in flags
        or "suppressed_prompt_echo" in flags
    ):
        hallucination_reasons.append("prompt_echo_detected")

    if contains_timestamp:
        suspicious_reasons.append("contains_timestamp")
    if contains_date:
        suspicious_reasons.append("contains_date")
    if contains_bracket_time:
        suspicious_reasons.append("contains_bracket_timestamp")
    if contains_bot_names:
        suspicious_reasons.append("contains_bot_name")
    if suppressed:
        suspicious_reasons.append("suppressed")
    if quiet_audio:
        suspicious_reasons.append("quiet_audio")
    if hard_silence:
        suspicious_reasons.append("hard_silence")
    if rate_mismatch:
        suspicious_reasons.append("rate_mismatch")

    if hallucination_reasons:
        return "hallucinated", hallucination_reasons

    is_clean = (
        not suppressed
        and not flags
        and not prompt_echo_detected
        and not quiet_audio
        and not hard_silence
        and not rate_mismatch
        and isinstance(avg_logprob, (int, float))
        and isinstance(min_logprob, (int, float))
        and avg_logprob > -1.2
        and min_logprob > -2.5
    )
    if is_clean:
        return "legit", ["clean_metrics"]

    if suspicious_reasons:
        return "unknown", suspicious_reasons

    return "unknown", ["mixed_signals"]


def list_traces(
    base_url: str,
    public_key: str,
    secret_key: str,
    params: Dict[str, Any],
    limit: int,
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    page = 1
    while True:
        query = dict(params)
        query["page"] = page
        query["limit"] = limit
        response = requests.get(
            f"{base_url.rstrip('/')}/api/public/traces",
            params=query,
            auth=(public_key, secret_key),
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else payload
        if not data:
            break
        results.extend(data)
        if len(data) < limit:
            break
        page += 1
        time.sleep(0.2)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit Langfuse transcription traces for hallucinations.",
    )
    parser.add_argument("--date", help="Date in YYYY-MM-DD (EST).")
    parser.add_argument("--window", default=DEFAULT_WINDOW)
    parser.add_argument("--tz-offset", default=DEFAULT_TZ_OFFSET)
    parser.add_argument("--name", default=DEFAULT_NAME)
    parser.add_argument("--meeting-id", default="")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--out-dir", default="analysis/hallucination-audit")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args()

    load_env(ENV_PATH)
    public_key = os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    base_url = (
        args.base_url or os.getenv("LANGFUSE_BASE_URL", "").strip() or DEFAULT_BASE_URL
    )
    if not public_key or not secret_key:
        raise SystemExit("Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY in env.")

    if args.date:
        dates = [args.date]
    else:
        today, yesterday = get_ny_dates()
        dates = [today, yesterday]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    window_results: Dict[str, List[Dict[str, Any]]] = {}
    for date_str in dates:
        from_ts, to_ts = window_to_range(date_str, args.window, args.tz_offset)
        params = {
            "name": args.name,
            "fromTimestamp": from_ts,
            "toTimestamp": to_ts,
            "fields": DEFAULT_FIELDS,
            "orderBy": "timestamp.asc",
        }
        traces = list_traces(base_url, public_key, secret_key, params, args.limit)
        window_key = f"{date_str}_{args.window.replace(':', '')}"
        window_results[window_key] = traces
        raw_path = out_dir / f"raw_traces_{window_key}.json"
        raw_path.write_text(json.dumps(traces, indent=2), encoding="utf-8")

    chosen_window = max(window_results.keys(), key=lambda k: len(window_results[k]))
    traces = window_results[chosen_window]
    if not traces:
        raise SystemExit("No traces found in the specified window(s).")

    meeting_counts: Dict[str, int] = defaultdict(int)
    for trace in traces:
        meeting_id = (trace.get("metadata") or {}).get("meetingId")
        if meeting_id:
            meeting_counts[meeting_id] += 1
    if not meeting_counts:
        raise SystemExit("No meetingId found in trace metadata.")

    meeting_id = args.meeting_id.strip()
    if not meeting_id:
        meeting_id = max(meeting_counts.items(), key=lambda item: item[1])[0]
    filtered = [
        t for t in traces if (t.get("metadata") or {}).get("meetingId") == meeting_id
    ]

    records: List[Dict[str, Any]] = []
    for trace in filtered:
        metadata = trace.get("metadata") or {}
        input_data = trace.get("input") or {}
        output = trace.get("output")
        output_text = (
            output
            if isinstance(output, str)
            else json.dumps(output)
            if output is not None
            else ""
        )
        audio_id = parse_audio_media_id(input_data.get("audio"))
        record = {
            "trace_id": trace.get("id"),
            "trace_timestamp": trace.get("timestamp"),
            "meeting_id": metadata.get("meetingId"),
            "guild_id": metadata.get("guildId"),
            "channel_id": metadata.get("channelId"),
            "snippet_user_id": metadata.get("snippetUserId"),
            "snippet_timestamp": metadata.get("snippetTimestamp"),
            "audio_seconds": metadata.get("audioSeconds"),
            "audio_bytes": metadata.get("audioBytes"),
            "audio_attachment_bytes": metadata.get("audioAttachmentBytes"),
            "audio_media_id": audio_id,
            "output_text": output_text,
            "normalized_text": normalize_text(output_text) if output_text else "",
            "transcription_flags": metadata.get("transcriptionFlags") or [],
            "suppressed": metadata.get("suppressed"),
            "quiet_audio": metadata.get("quietAudio"),
            "quiet_by_peak": metadata.get("quietByPeak"),
            "quiet_by_activity": metadata.get("quietByActivity"),
            "hard_silence_detected": metadata.get("hardSilenceDetected"),
            "rate_mismatch_detected": metadata.get("rateMismatchDetected"),
            "prompt_echo_detected": metadata.get("promptEchoDetected"),
            "prompt_echo_metrics": metadata.get("promptEchoMetrics"),
            "logprob_avg": (metadata.get("logprobMetrics") or {}).get("avgLogprob"),
            "logprob_min": (metadata.get("logprobMetrics") or {}).get("minLogprob"),
            "logprob_tokens": (metadata.get("logprobMetrics") or {}).get("tokenCount"),
            "transcript_char_count": metadata.get("transcriptCharCount"),
            "transcript_word_count": metadata.get("transcriptWordCount"),
            "transcript_syllable_count": metadata.get("transcriptSyllableCount"),
            "words_per_second": metadata.get("wordsPerSecond"),
            "syllables_per_second": metadata.get("syllablesPerSecond"),
            "noise_gate_metrics": metadata.get("noiseGateMetrics"),
            "trace_url_path": trace.get("htmlPath"),
        }
        classification, reasons = classify_record(record)
        record["classification"] = classification
        record["classification_reasons"] = reasons
        records.append(record)

    duplicate_groups = build_duplicate_groups(records)
    near_duplicate_groups = build_near_duplicate_groups(records)
    for record in records:
        record["duplicate_group_id"] = duplicate_groups.get(record["trace_id"])
        record["near_duplicate_group_id"] = near_duplicate_groups.get(
            record["trace_id"]
        )

    meeting_dir = out_dir / meeting_id
    meeting_dir.mkdir(parents=True, exist_ok=True)
    raw_filtered_path = meeting_dir / "transcriptions_raw.json"
    raw_filtered_path.write_text(json.dumps(filtered, indent=2), encoding="utf-8")
    classified_path = meeting_dir / "transcriptions_classified.json"
    classified_path.write_text(json.dumps(records, indent=2), encoding="utf-8")

    counts = defaultdict(int)
    for record in records:
        counts[record["classification"]] += 1

    summary_lines = [
        f"Meeting ID: {meeting_id}",
        f"Trace window: {chosen_window}",
        f"Base URL: {base_url}",
        "",
        "Counts:",
        f"- Total traces: {len(records)}",
        f"- Hallucinated: {counts['hallucinated']}",
        f"- Legit: {counts['legit']}",
        f"- Unknown: {counts['unknown']}",
        "",
        "Top duplicate groups (exact):",
    ]

    group_counts: Dict[int, int] = defaultdict(int)
    for record in records:
        group_id = record.get("duplicate_group_id")
        if group_id:
            group_counts[group_id] += 1
    for group_id, count in sorted(
        group_counts.items(), key=lambda item: item[1], reverse=True
    )[:10]:
        summary_lines.append(f"- Group {group_id}: {count} entries")

    summary_lines.append("")
    summary_lines.append("Top near-duplicate groups:")
    near_group_counts: Dict[int, int] = defaultdict(int)
    for record in records:
        group_id = record.get("near_duplicate_group_id")
        if group_id:
            near_group_counts[group_id] += 1
    for group_id, count in sorted(
        near_group_counts.items(), key=lambda item: item[1], reverse=True
    )[:10]:
        summary_lines.append(f"- Group {group_id}: {count} entries")

    summary_path = meeting_dir / "summary.md"
    summary_path.write_text("\n".join(summary_lines), encoding="utf-8")


if __name__ == "__main__":
    main()
