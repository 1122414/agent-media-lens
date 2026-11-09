import json
import os
import subprocess
import sys
import wave
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "workers"))
from media_worker import choose_frames, model_snapshot, probe, read_ocr, transcribe


def test_scene_and_caption_selection() -> None:
    initial = bytes(1024)
    subtitle = bytes(768) + bytes([200]) * 256
    assert choose_frames(
        [initial, initial, subtitle, subtitle, bytes([255]) * 1024], 4, 3
    ) == [0, 2, 4]
    assert choose_frames([initial] * 100, 4, 30) == [0, 99]


def test_real_silent_clip(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=10:duration=3",
            "-c:v",
            "mpeg4",
            str(source),
        ],
        check=True,
    )
    with pytest.raises(ValueError, match="DURATION_LIMIT"):
        probe(source, 1)
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "workers/media_worker.py"),
            str(tmp_path),
            "--ocr-lang",
            "eng",
            "--max-frames",
            "2",
        ],
        check=True,
    )
    result = json.loads((tmp_path / "evidence.json").read_text())
    assert result["transcript"]["segments"] == []
    assert 1 <= len(result["frames"]) <= 2
    for frame in result["frames"]:
        assert (tmp_path / frame["imagePath"]).read_bytes().startswith(b"\xff\xd8")
    assert len(result["ocr"]) == len(result["frames"])


def test_first_and_last_samples_and_quiet_tail() -> None:
    dark, bright = bytes(1024), bytes([255]) * 1024
    timeline = [dark, bright] * 215 + [dark] * 573
    assert choose_frames(timeline, 4, 1) == [0]
    assert choose_frames(timeline, 4, 2) == [0, 1002]
    assert choose_frames(timeline[:27], 4, 12)[-1] == 26
    stamps = choose_frames(timeline, 4, 30)
    assert len(stamps) <= 30 and stamps[0] == 0 and stamps[-1] == 1002
    assert max(b - a for a, b in pairwise(stamps)) <= 46


def test_model_cache_fallback_only_for_resolution(tmp_path, monkeypatch):
    for name in ("model.bin", "config.json", "tokenizer.json"):
        (tmp_path / name).touch()
    calls = []

    def download(name, local_files_only):
        calls.append((name, local_files_only))
        if name == "small":
            raise FileNotFoundError()
        return tmp_path

    monkeypatch.setattr("faster_whisper.utils.download_model", download)
    assert model_snapshot("small", True) == (str(tmp_path), "base")
    assert calls == [("small", True), ("small", False), ("base", True)]
    with pytest.raises(ValueError, match="MODEL_UNAVAILABLE"):
        model_snapshot("small", False)

    def denied(*args, **kwargs):
        raise PermissionError(13, "access denied")

    monkeypatch.setattr("faster_whisper.utils.download_model", denied)
    with pytest.raises(PermissionError):
        model_snapshot("small", True)


def test_missing_offline_model_keeps_real_visual_evidence(tmp_path):
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=160x90:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1",
            "-shortest",
            "-c:v",
            "mpeg4",
            str(tmp_path / "source.mp4"),
        ],
        check=True,
    )
    env = {
        **os.environ,
        "HF_HOME": str(tmp_path / "hf"),
        "HF_HUB_CACHE": str(tmp_path / "hf" / "hub"),
        "HF_HUB_OFFLINE": "1",
    }
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "workers/media_worker.py"),
            str(tmp_path),
            "--model",
            "small",
            "--ocr-lang",
            "eng",
        ],
        env=env,
        check=True,
    )
    result = json.loads((tmp_path / "evidence.json").read_text())
    assert result["warnings"] == ["MODEL_UNAVAILABLE"]
    assert result["transcript"]["status"] == "unavailable"
    assert result["transcript"]["segments"] == []
    assert result["ocr"][0]["frameId"] == result["frames"][0]["id"]
    assert (
        (tmp_path / result["frames"][0]["imagePath"])
        .read_bytes()
        .startswith(b"\xff\xd8")
    )


def test_transcript_keeps_uncertain_words_and_bounds(tmp_path, monkeypatch):
    path = tmp_path / "audio.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(bytes(32000))
    monkeypatch.setattr("media_worker.model_snapshot", lambda *_: ("snapshot", "base"))

    class Model:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, pcm, **kwargs):
            assert kwargs["initial_prompt"] == "example term"
            return [
                SimpleNamespace(
                    text=" possibly wrong ",
                    start=-0.1,
                    end=1.5,
                    avg_logprob=-1.2,
                    no_speech_prob=0.4,
                )
            ], SimpleNamespace(language="en")

    monkeypatch.setattr("faster_whisper.WhisperModel", Model)
    result = transcribe(path, "small", "cpu", True, "example term", 2)
    assert result["warning"] == "MODEL_FALLBACK" and result["model"] == "base"
    assert result["segments"] == [
        {
            "text": "possibly wrong",
            "start": 0,
            "end": 1,
            "avgLogprob": -1.2,
            "noSpeechProb": 0.4,
            "lowConfidence": True,
        }
    ]


def test_ocr_raw_short_terms_page_boundaries_and_outro(tmp_path, monkeypatch):
    def tsv(words):
        return (
            "header\n"
            + "\n".join(
                f"5\t1\t1\t1\t1\t1\t0\t0\t5\t5\t{conf}\t{word}" for word, conf in words
            )
        ).encode()

    data = tsv([("AI", 96), ("junk", 18)])
    monkeypatch.setattr("media_worker.run", lambda *a: data)
    images = [
        {"page": p, "timestamp": None, "id": f"f00{i}", "imagePath": f"f00{i}.jpg"}
        for i, p in enumerate([1, 1, 2])
    ]
    rows = read_ocr(tmp_path, images, "eng", "douyin", None)
    assert (
        rows[0]["text"] == "AI …"
        and rows[0]["rawText"] == "AI junk"
        and rows[0]["confidence"] == 96
    )
    assert rows[1]["repeatedOf"] == "f000" and "repeatedOf" not in rows[2]
    for phrase, platform, second, expected in [
        ("抖音号", "douyin", 32, False),
        ("发现更多创作者", "douyin", 0, False),
        ("发现更多创作者", "douyin", 32, True),
        ("发现更多创作者", "bilibili", 32, False),
    ]:
        data = tsv([(phrase, 89)])
        frame = {"timestamp": second, "id": "f003", "imagePath": "f003.jpg"}
        read_ocr(tmp_path, [frame], "chi_sim", platform, 33)
        assert (frame.get("role") == "possible_platform_outro") == expected
