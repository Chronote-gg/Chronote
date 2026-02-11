import argparse
import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple


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


def build_index(words: List[str]) -> Dict[str, List[int]]:
    index: Dict[str, List[int]] = {}
    for pos, word in enumerate(words):
        if len(word) < 4:
            continue
        index.setdefault(word, []).append(pos)
    return index


def best_match(
    snippet_text: str,
    snippet_words: List[str],
    full_text: str,
    full_words: List[str],
    index: Dict[str, List[int]],
) -> Tuple[Optional[float], str, Optional[Tuple[int, int]]]:
    if not snippet_text:
        return None, "empty", None
    if snippet_text in full_text:
        return 1.0, "substring", None

    unique_words = sorted(set(snippet_words), key=len, reverse=True)
    candidates = [word for word in unique_words if len(word) >= 4][:3]
    if not candidates:
        return None, "no_candidates", None

    window_size = max(8, min(len(full_words), len(snippet_words) + 6))
    best_score: Optional[float] = None
    best_window: Optional[Tuple[int, int]] = None
    for word in candidates:
        positions = index.get(word, [])
        if len(positions) > 100:
            positions = positions[:100]
        for pos in positions:
            start = max(0, pos - 3)
            end = min(len(full_words), start + window_size)
            window_text = " ".join(full_words[start:end])
            if not window_text:
                continue
            dist = levenshtein_distance(snippet_text, window_text)
            ratio = dist / max(len(snippet_text), len(window_text))
            score = 1 - ratio
            if best_score is None or score > best_score:
                best_score = score
                best_window = (start, end)
    return best_score, "fuzzy", best_window


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Align snippet transcripts with full transcript text.",
    )
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--input", default="")
    parser.add_argument("--threshold", type=float, default=0.85)
    args = parser.parse_args()

    meeting_dir = Path("analysis/hallucination-audit") / args.meeting_id
    input_path = (
        Path(args.input)
        if args.input
        else meeting_dir / "transcriptions_classified_with_audio.json"
    )
    full_path = meeting_dir / "full_transcript.txt"

    if not input_path.exists():
        raise SystemExit(f"Missing {input_path}")
    if not full_path.exists():
        raise SystemExit(f"Missing {full_path}")

    records = json.loads(input_path.read_text(encoding="utf-8"))
    full_text_raw = full_path.read_text(encoding="utf-8")
    full_text = normalize_text(full_text_raw)
    full_words = full_text.split()
    index = build_index(full_words)

    for record in records:
        snippet_text_raw = record.get("output_text") or ""
        snippet_text = normalize_text(snippet_text_raw)
        snippet_words = snippet_text.split()
        score, method, window = best_match(
            snippet_text,
            snippet_words,
            full_text,
            full_words,
            index,
        )
        record["full_transcript_match_score"] = score
        record["full_transcript_match_method"] = method
        record["full_transcript_match_window"] = list(window) if window else None
        record["full_transcript_match_found"] = bool(
            score is not None and score >= args.threshold
        )

    output_json = meeting_dir / "transcriptions_classified_with_audio_and_full.json"
    output_json.write_text(json.dumps(records, indent=2), encoding="utf-8")

    output_csv = meeting_dir / "transcriptions_classified_with_audio_and_full.csv"
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
