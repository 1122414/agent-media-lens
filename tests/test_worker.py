import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "workers"))
from media_worker import choose_frames, probe


def test_scene_and_caption_selection() -> None:
    initial = bytes(1024)
    subtitle = bytes(768) + bytes([200]) * 256
    assert choose_frames(
        [initial, initial, subtitle, subtitle, bytes([255]) * 1024], 4, 3
    ) == [0, 2, 4]
    assert choose_frames([initial] * 100, 4, 30) == [0]


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
