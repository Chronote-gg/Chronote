"""Offline regressions: python -m unittest discover -s analysis/hallucination-audit."""
import csv
import json
from contextlib import contextmanager
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def working_directory(directory):
    previous = os.getcwd()
    os.chdir(directory)
    try:
        yield
    finally:
        os.chdir(previous)


class AuditToolsTests(unittest.TestCase):
    def test_langfuse_defaults_to_us(self):
        for name in ["run_audit", "compute_audio_volume", "create_langfuse_dataset_sample"]:
            self.assertEqual(load(name).DEFAULT_BASE_URL, "https://us.cloud.langfuse.com")

    def test_exact_alignment_requires_whole_tokens(self):
        align = load("align_with_full_transcript")
        self.assertNotEqual(align.best_match("he", ["he"], "the cat", ["the", "cat"], {})[0], 1.0)
        self.assertEqual(align.best_match("cat", ["cat"], "the cat", ["the", "cat"], {})[0], 1.0)

    def test_fuzzy_alignment_uses_snippet_length_and_anchor_offset(self):
        align = load("align_with_full_transcript")
        examples = [
            ("we should launch product", "we should launch products"),
            ("we can all take a quick break then launch", "we can all take a quick break then launches"),
            ("we should schedule the product launch for friday", "we should schedule the next product launch for friday"),
            ("we should schedule the next product launch for friday", "we should schedule the product launch for friday"),
        ]
        for snippet, reference in examples:
            with self.subTest(snippet=snippet):
                full = f"yesterday {reference} tomorrow"
                words = full.split()
                score, method, window = align.best_match(snippet, snippet.split(), full, words, align.build_index(words))
                self.assertGreaterEqual(score, 0.85)
                self.assertEqual(method, "fuzzy")
                self.assertEqual(" ".join(words[window[0]:window[1]]), reference)

    def test_fuzzy_alignment_does_not_claim_unrelated_speech(self):
        align = load("align_with_full_transcript")
        full = "the launch failed and everything must be postponed"
        words = full.split()
        score, _, _ = align.best_match("we should launch product", "we should launch product".split(), full, words, align.build_index(words))
        self.assertTrue(score is None or score < 0.85)

    def test_failed_segment_cannot_publish_partial_reference(self):
        audio = load("transcribe_full_audio")
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "full_transcript.txt"
            reference.write_text("previous run", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                audio.publish_transcript(Path(directory), [{"text": "synthetic"}, {"error": "failed"}])
            self.assertFalse(reference.exists())
            audio.publish_transcript(Path(directory), [{"text": "synthetic"}])
            self.assertEqual(reference.read_text(encoding="utf-8"), "synthetic")

    def test_ffmpeg_failure_is_not_a_measurement(self):
        volume = load("compute_audio_volume")
        import subprocess
        def fail_command(*args, **kwargs):
            if kwargs.get("check"):
                raise subprocess.CalledProcessError(1, args[0])
            return Mock(returncode=1, stderr="invalid audio")
        with patch.object(volume.subprocess, "run", side_effect=fail_command):
            with self.assertRaises(subprocess.CalledProcessError):
                volume.compute_volume(Path("invalid.mp3"))

    def test_requested_meeting_in_less_populated_window(self):
        audit = load("run_audit")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "LANGFUSE_PUBLIC_KEY": "test", "LANGFUSE_SECRET_KEY": "test"
        }), patch.object(audit, "load_env"), patch.object(audit, "list_observations", side_effect=[
            [{"id": "a", "metadata": {"meetingId": "other"}}, {"id": "b", "metadata": {"meetingId": "other"}}],
            [{"id": "c", "traceId": "trace-c", "projectId": "project", "metadata": {"meetingId": "wanted"}, "output": "Synthetic speech"}],
        ]), patch("sys.argv", ["run_audit", "--meeting-id", "wanted", "--out-dir", directory]):
            audit.main()
            self.assertTrue((Path(directory) / "wanted" / "transcriptions_raw.json").exists())

    def test_error_retry_redownloads_corrupt_audio_and_keeps_later_csv_metrics(self):
        volume = load("compute_audio_volume")
        with tempfile.TemporaryDirectory() as directory, working_directory(directory):
            meeting_dir = Path("analysis/hallucination-audit/wanted")
            meeting_dir.mkdir(parents=True)
            records = [{"trace_id": "without-audio"}, {"trace_id": "with-audio", "audio_media_id": "media"}]
            (meeting_dir / "transcriptions_classified.json").write_text(json.dumps(records), encoding="utf-8")
            (meeting_dir / "audio_volume_metrics.json").write_text(json.dumps({"media": {"audio_volume_status": "error:invalid audio"}}), encoding="utf-8")
            cached = Path("analysis/hallucination-audit/audio_cache/media.mp3")
            cached.parent.mkdir()
            cached.write_bytes(b"corrupt")
            def download(_url, target):
                target.write_bytes(b"valid audio")
            def measure(target):
                self.assertEqual(target.read_bytes(), b"valid audio")
                return -20.0, -4.0, None
            with patch.dict(os.environ, {"LANGFUSE_PUBLIC_KEY": "test", "LANGFUSE_SECRET_KEY": "test"}), patch.object(volume, "load_env"), patch.object(volume, "fetch_media_url", return_value="https://example.test/audio"), patch.object(volume, "download_media", side_effect=download) as fetched, patch.object(volume, "compute_volume", side_effect=measure), patch("sys.argv", ["volume", "--meeting-id", "wanted", "--retry-errors"]):
                volume.main()
                fetched.assert_called_once()
            with (meeting_dir / "transcriptions_classified_with_audio.csv").open(encoding="utf-8", newline="") as handle:
                exported = list(csv.DictReader(handle))
            self.assertEqual(exported[0]["audio_mean_volume_db"], "")
            self.assertEqual(exported[1]["audio_mean_volume_db"], "-20.0")
            self.assertEqual(exported[1]["audio_max_volume_db"], "-4.0")

    def test_observations_cursor_continues_after_short_or_empty_pages(self):
        audit = load("run_audit")
        pages = [Mock(), Mock(), Mock()]
        pages[0].json.return_value = {"data": [{"id": "one"}], "meta": {"cursor": "next"}}
        pages[1].json.return_value = {"data": [], "meta": {"cursor": "last"}}
        pages[2].json.return_value = {"data": [{"id": "two"}], "meta": {"cursor": None}}
        params = {"fromStartTime": "2026-10-08T00:00:00Z", "toStartTime": "2026-10-08T01:00:00Z", "fields": audit.DEFAULT_FIELDS, "name": "transcription"}
        with patch.object(audit.requests, "get", side_effect=pages) as get, patch.object(audit.time, "sleep"):
            self.assertEqual([row["id"] for row in audit.list_observations("https://example.test", "test", "test", params, 100)], ["one", "two"])
        queries = [call.kwargs["params"] for call in get.call_args_list]
        self.assertNotIn("cursor", queries[0])
        self.assertEqual(queries[1]["cursor"], "next")
        self.assertEqual(queries[2]["cursor"], "last")
        for call in get.call_args_list:
            self.assertEqual(call.args[0], "https://example.test/api/public/v2/observations")
            self.assertEqual(call.kwargs["params"]["fromStartTime"], params["fromStartTime"])
            self.assertEqual(call.kwargs["params"]["toStartTime"], params["toStartTime"])
            self.assertNotIn("page", call.kwargs["params"])

    def test_observations_export_retains_shared_trace_snippets_and_decodes_io(self):
        audit = load("run_audit")
        observations = [
            {"id": "obs-one", "traceId": "shared", "projectId": "project", "startTime": "2026-10-08T00:00:00Z", "metadata": {"meetingId": "wanted"}, "input": json.dumps({"audio": "@@@langfuseMedia:type=audio|id=media|source=bytes@@@"}), "output": json.dumps("Synthetic meeting speech")},
            {"id": "obs-two", "traceId": "shared", "projectId": "project", "metadata": {"meetingId": "wanted"}, "output": "Synthetic meeting speech"},
            {"id": "obs-three", "traceId": "shared", "projectId": "project", "metadata": {"meetingId": "wanted"}, "output": "Another independent discussion"},
        ]
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"LANGFUSE_PUBLIC_KEY": "test", "LANGFUSE_SECRET_KEY": "test"}), patch.object(audit, "load_env"), patch.object(audit, "list_observations", return_value=observations) as fetch, patch("sys.argv", ["audit", "--date", "2026-10-08", "--meeting-id", "wanted", "--out-dir", directory]):
            audit.main()
            exported = json.loads((Path(directory) / "wanted/transcriptions_classified.json").read_text(encoding="utf-8"))
        self.assertEqual(len(exported), 3)
        self.assertEqual(exported[0]["output_text"], "Synthetic meeting speech")
        self.assertEqual(exported[0]["audio_media_id"], "media")
        self.assertEqual(exported[0]["trace_timestamp"], observations[0]["startTime"])
        self.assertEqual(exported[0]["trace_url_path"], "/project/project/traces/shared")
        self.assertEqual([row["observation_id"] for row in exported], ["obs-one", "obs-two", "obs-three"])
        self.assertTrue(all(row["trace_id"] == "shared" for row in exported))
        self.assertEqual(exported[0]["duplicate_group_id"], exported[1]["duplicate_group_id"])
        self.assertIsNone(exported[2]["duplicate_group_id"])
        self.assertIsNone(exported[2]["near_duplicate_group_id"])
        params = fetch.call_args.args[3]
        self.assertIn("fromStartTime", params)
        self.assertIn("toStartTime", params)
        self.assertIn("metadata", params["fields"])
        self.assertIn("noiseGateMetrics", params["expandMetadata"])
        self.assertNotIn("parseIoAsJson", params)

    def test_dataset_items_keep_distinct_observations_on_a_shared_trace(self):
        dataset = load("create_langfuse_dataset_sample")
        records = [{"trace_id": "shared", "observation_id": name, "classification": "unknown"} for name in ["one", "two"]]
        with tempfile.TemporaryDirectory() as directory, working_directory(directory), patch.dict(os.environ, {"LANGFUSE_PUBLIC_KEY": "test", "LANGFUSE_SECRET_KEY": "test"}), patch.object(dataset, "load_env"), patch.object(dataset, "load_records", return_value=records), patch.object(dataset, "ensure_dataset"), patch.object(dataset, "create_dataset_item") as create, patch.object(dataset.time, "sleep"), patch("sys.argv", ["dataset", "--meeting-id", "wanted", "--dataset-name", "synthetic", "--sample-size", "2", "--counts", "unknown=2"]):
            dataset.main()
        payloads = [call.args[2] for call in create.call_args_list]
        self.assertEqual({item["id"] for item in payloads}, {"wanted-one", "wanted-two"})
        self.assertEqual({item["sourceObservationId"] for item in payloads}, {"one", "two"})
        self.assertTrue(all(item["sourceTraceId"] == "shared" for item in payloads))

    def test_segments_are_regenerated(self):
        audio = load("transcribe_full_audio")
        with tempfile.TemporaryDirectory() as directory:
            segments = Path(directory) / "segments"
            segments.mkdir()
            stale = segments / "segment_001.mp3"
            stale.write_bytes(b"old")
            with patch.object(audio.subprocess, "run") as run:
                audio.segment_audio(Path(directory) / "new.mp3", segments, 30)
            self.assertFalse(stale.exists())
            run.assert_called_once()
            self.assertIn("30", run.call_args.args[0])

    def test_rejected_dataset_item_fails(self):
        dataset = load("create_langfuse_dataset_sample")
        response = Mock(status_code=400)
        response.raise_for_status.side_effect = dataset.requests.HTTPError("invalid payload")
        with patch.object(dataset.requests, "post", return_value=response):
            with self.assertRaises(dataset.requests.HTTPError):
                dataset.create_dataset_item("https://example.test", ("test", "test"), {})


if __name__ == "__main__":
    unittest.main()
