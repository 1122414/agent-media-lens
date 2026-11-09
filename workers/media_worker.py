"""Process the task directory's local MP4 and emit stage events as JSON lines."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any

MEDIA_INPUT = [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov",
    "-enable_drefs",
    "0",
    "-use_absolute_path",
    "0",
    "-max_pixels",
    "16777216",
]
FFMPEG = ["ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "1"]


def run(args: list[str], timeout: int = 180) -> bytes:
    result = subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=True,
    )
    return result.stdout


def event(stage: str) -> None:
    print(json.dumps({"stage": stage}), flush=True)


def probe(path: Path, limit: int) -> tuple[float, bool]:
    report = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                *MEDIA_INPUT,
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(path),
            ]
        )
    )
    streams = report["streams"]
    duration = float(report["format"]["duration"])
    if not math.isfinite(duration) or not 0 < duration <= limit:
        raise ValueError("DURATION_LIMIT")
    videos = [
        s
        for s in streams
        if s["codec_type"] == "video" and not s["disposition"].get("attached_pic")
    ]
    if not videos or videos[0]["width"] * videos[0]["height"] > 16777216:
        raise ValueError("INVALID_VIDEO")
    return duration, any(s["codec_type"] == "audio" for s in streams)


def transcribe(path: Path, model_name: str, device: str) -> dict[str, Any]:
    import ctranslate2
    import numpy as np
    from faster_whisper import WhisperModel

    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
    if model_name == "auto":
        model_name = "small" if device == "cuda" else "base"
    settings = {
        "device": device,
        "compute_type": "int8" if device == "cpu" else "float16",
        "cpu_threads": min(4, os.cpu_count() or 1),
    }
    try:
        model = WhisperModel(model_name, local_files_only=True, **settings)
    except (OSError, RuntimeError, ValueError):
        model = WhisperModel(model_name, **settings)
    with wave.open(str(path), "rb") as wav:
        pcm = (
            np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(
                np.float32
            )
            / 32768.0
        )
    segments, info = model.transcribe(pcm, vad_filter=True, beam_size=3)
    rows = [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in segments
        if s.text.strip()
    ]
    return {
        "language": info.language if rows else None,
        "text": " ".join(str(r["text"]) for r in rows),
        "segments": rows,
    }


def choose_frames(samples: list[bytes], interval: float, maximum: int) -> list[int]:
    """Rank real one-second samples by scene and lower-third change; reserve coverage."""
    if not samples:
        return [0]
    changes: list[tuple[float, int]] = []
    candidates = [0]
    last = samples[0]
    for index in range(1, len(samples)):
        delta = [
            abs(a - b) for a, b in zip(samples[index], samples[index - 1], strict=True)
        ]
        score = max(sum(delta) / len(delta), sum(delta[-256:]) / 256)
        if score >= 12:
            changes.append((score, index))
        if (
            index - candidates[-1] >= interval
            and sum(abs(a - b) for a, b in zip(samples[index], last, strict=True))
            / len(last)
            >= 2
        ):
            candidates.append(index)
            last = samples[index]
    target = min(len(candidates), max(1, (maximum + 1) // 2))
    selected = {
        candidates[round(i * (len(candidates) - 1) / max(1, target - 1))]
        for i in range(target)
    }
    for index in [i for _, i in sorted(changes, reverse=True)] + candidates:
        if len(selected) >= maximum:
            break
        selected.add(index)
    return sorted(selected)


def frames(
    path: Path, directory: Path, duration: float, interval: float, maximum: int
) -> list[dict[str, Any]]:
    pixels = run(
        [
            *FFMPEG,
            *MEDIA_INPUT,
            "-i",
            str(path),
            "-map",
            "0:V:0",
            "-t",
            str(duration),
            "-vf",
            "fps=1:start_time=0,scale=32:32,format=gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    samples = [pixels[i : i + 1024] for i in range(0, len(pixels) - 1023, 1024)]
    rows = []
    for n, second in enumerate(choose_frames(samples, interval, maximum)):
        name = f"f{n:03}"
        image = directory / (name + ".jpg")
        run(
            [
                *FFMPEG,
                "-ss",
                str(second),
                *MEDIA_INPUT,
                "-i",
                str(path),
                "-map",
                "0:V:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
                "-q:v",
                "5",
                "-n",
                str(image),
            ]
        )
        if not image.is_file() or not 0 < image.stat().st_size <= 512_000:
            raise ValueError("IMAGE_LIMIT")
        rows.append({"id": name, "timestamp": second, "imagePath": image.name})
    return rows


def process(directory: Path, options: argparse.Namespace) -> dict[str, Any]:
    path = directory / "source.mp4"
    event("EXTRACTING_AUDIO")
    duration, audio = probe(path, options.max_seconds)
    transcript: dict[str, Any] = {"language": None, "text": "", "segments": []}
    wav = directory / "audio.wav"
    try:
        if audio:
            run(
                [
                    *FFMPEG,
                    *MEDIA_INPUT,
                    "-i",
                    str(path),
                    "-map",
                    "0:a:0",
                    "-t",
                    str(duration),
                    "-vn",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    "-n",
                    str(wav),
                ]
            )
        event("TRANSCRIBING")
        if audio:
            transcript = transcribe(wav, options.model, options.device)
    finally:
        wav.unlink(missing_ok=True)
    event("EXTRACTING_FRAMES")
    images = frames(path, directory, duration, options.interval, options.max_frames)
    event("OCR")
    ocr = []
    for image in images:
        text = (
            run(
                [
                    "tesseract",
                    str(directory / image["imagePath"]),
                    "stdout",
                    "-l",
                    options.ocr_lang,
                    "--psm",
                    "11",
                ],
                60,
            )
            .decode()
            .strip()[:16000]
        )
        ocr.append(
            {"timestamp": image["timestamp"], "frameId": image["id"], "text": text}
        )
    return {
        "duration": duration,
        "transcript": transcript,
        "frames": images,
        "ocr": ocr,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument(
        "--model",
        default="auto",
        choices=["auto", "tiny", "base", "small", "medium", "large-v3"],
    )
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--max-seconds", type=int, default=600)
    parser.add_argument("--interval", type=float, default=4)
    parser.add_argument("--max-frames", type=int, default=30)
    parser.add_argument("--ocr-lang", default="chi_sim+eng")
    opts = parser.parse_args()
    try:
        if not (
            1 <= opts.max_frames <= 120
            and 1 <= opts.interval <= 60
            and 1 <= opts.max_seconds <= 3600
        ):
            raise ValueError("INVALID_OPTIONS")
        result = process(opts.directory, opts)
        (opts.directory / "evidence.json").write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )
        return 0
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        subprocess.SubprocessError,
    ) as exc:
        codes = {"DURATION_LIMIT", "INVALID_VIDEO", "IMAGE_LIMIT", "INVALID_OPTIONS"}
        code = (
            str(exc)
            if isinstance(exc, ValueError) and str(exc) in codes
            else "WORKER_FAILED"
        )
        print(json.dumps({"error": code, "type": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
