"""Offline regressions: python -m unittest discover -s analysis/hallucination-audit."""
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


class AuditToolsTests(unittest.TestCase):
    def test_langfuse_defaults_to_us(self):
        for name in ["run_audit", "compute_audio_volume", "create_langfuse_dataset_sample"]:
            self.assertEqual(load(name).DEFAULT_BASE_URL, "https://us.cloud.langfuse.com")

    def test_exact_alignment_requires_whole_tokens(self):
        align = load("align_with_full_transcript")
        self.assertNotEqual(align.best_match("he", ["he"], "the cat", ["the", "cat"], {})[0], 1.0)
        self.assertEqual(align.best_match("cat", ["cat"], "the cat", ["the", "cat"], {})[0], 1.0)

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
        }), patch.object(audit, "load_env"), patch.object(audit, "list_traces", side_effect=[
            [{"id": "a", "metadata": {"meetingId": "other"}}, {"id": "b", "metadata": {"meetingId": "other"}}],
            [{"id": "c", "metadata": {"meetingId": "wanted"}, "output": "Synthetic speech"}],
        ]), patch("sys.argv", ["run_audit", "--meeting-id", "wanted", "--out-dir", directory]):
            audit.main()
            self.assertTrue((Path(directory) / "wanted" / "transcriptions_raw.json").exists())

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
