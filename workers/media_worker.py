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

from ocr_evidence import parse_lines, summarize

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


class WorkerProblem(ValueError):
    def __init__(self, code: str, **fields: object) -> None:
        super().__init__(code)
        self.fields = fields


def run(args: list[str], timeout: int = 180) -> bytes:
    try:
        return subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=True,
        ).stdout
    except FileNotFoundError as exc:
        raise WorkerProblem("TOOL_MISSING", tool=args[0]) from exc
    except subprocess.TimeoutExpired as exc:
        raise WorkerProblem("TOOL_TIMEOUT", tool=args[0]) from exc
    except subprocess.CalledProcessError as exc:
        raise WorkerProblem("TOOL_FAILED", tool=args[0]) from exc


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
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("INVALID_VIDEO")
    if duration > limit:
        raise WorkerProblem("DURATION_LIMIT", seconds=duration)
    videos = [
        s
        for s in streams
        if s["codec_type"] == "video" and not s["disposition"].get("attached_pic")
    ]
    if not videos or videos[0]["width"] * videos[0]["height"] > 16777216:
        raise ValueError("INVALID_VIDEO")
    return duration, any(s["codec_type"] == "audio" for s in streams)


def model_snapshot(name: str, fallback: bool) -> tuple[str, str]:
    from faster_whisper.utils import download_model

    def locate(size: str, local: bool) -> str:
        snapshot = str(download_model(size, local_files_only=local))
        # A snapshot directory alone can be left behind by an interrupted download.
        for filename in ("model.bin", "config.json", "tokenizer.json"):
            if not (Path(snapshot) / filename).is_file():
                raise FileNotFoundError(filename)
        return snapshot

    try:
        return locate(name, True), name
    except FileNotFoundError:
        pass
    try:
        return locate(name, False), name
    except OSError as exc:
        # Hub/transport errors generally have no errno. Surface actual OS failures.
        if exc.errno is not None and not isinstance(
            exc, (ConnectionError, TimeoutError, FileNotFoundError)
        ):
            raise
        if fallback and name != "base":
            try:
                return locate("base", True), "base"
            except FileNotFoundError:
                pass
        raise WorkerProblem("MODEL_UNAVAILABLE") from exc


def transcribe(
    path: Path,
    model_name: str,
    device: str,
    fallback: bool,
    prompt: str,
    duration: float,
) -> dict[str, Any]:
    import ctranslate2
    import numpy as np
    from faster_whisper import WhisperModel

    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
    if model_name == "auto":
        model_name = "small" if device == "cuda" else "base"
    snapshot, effective = model_snapshot(model_name, fallback)
    compute = "int8" if device == "cpu" else "float16"
    with wave.open(str(path), "rb") as wav:
        duration = min(duration, wav.getnframes() / wav.getframerate())
        pcm = (
            np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(
                np.float32
            )
            / 32768.0
        )
    try:
        model = WhisperModel(
            snapshot,
            local_files_only=True,
            device=device,
            compute_type=compute,
            cpu_threads=min(4, os.cpu_count() or 1),
        )
        segments, info = model.transcribe(
            pcm,
            vad_filter=True,
            beam_size=3,
            initial_prompt=prompt or None,
            condition_on_previous_text=True,
        )
        rows = []
        for segment in segments:
            if not segment.text.strip():
                continue
            start = max(0.0, min(duration, segment.start))
            rows.append(
                {
                    "start": start,
                    "end": max(start, min(duration, segment.end)),
                    "text": segment.text.strip(),
                    "avgLogprob": segment.avg_logprob,
                    "noSpeechProb": segment.no_speech_prob,
                    "lowConfidence": segment.avg_logprob < -1
                    or segment.no_speech_prob > 0.6,
                }
            )
    except RuntimeError as exc:
        raise WorkerProblem("ASR_FAILED") from exc
    return {
        "status": "ok" if rows else "no_speech",
        "model": effective,
        "device": device,
        "computeType": compute,
        **({"warning": "MODEL_FALLBACK"} if effective != model_name else {}),
        "language": info.language if rows else None,
        "text": " ".join(str(r["text"]) for r in rows),
        "segments": rows,
    }


def choose_frames(samples: list[bytes], interval: float, maximum: int) -> list[int]:
    """Reserve wall-clock anchors, then use the remaining budget for visual changes."""
    if not samples or maximum <= 1:
        return [0] if maximum > 0 else []
    last = len(samples) - 1
    if maximum == 2 or all(sample == samples[0] for sample in samples):
        return sorted({0, last})
    budget = min(maximum, len(samples))
    anchors = min(
        budget, max(2, min(math.ceil(budget * 0.75), math.ceil(last / interval) + 1))
    )
    selected = {round(i * last / (anchors - 1)) for i in range(anchors)}
    changes = []
    for i in range(1, len(samples)):
        delta = [abs(a - b) for a, b in zip(samples[i], samples[i - 1], strict=True)]
        score = max(sum(delta) / len(delta), sum(delta[-256:]) / 256)
        if score >= 12:
            changes.append((score, i))
    for _, i in sorted(changes, reverse=True):
        if len(selected) >= budget:
            break
        selected.add(i)
    return sorted(selected)


def write_frame(path: Path, image: Path, second: float | None) -> None:
    if second is None:
        # Force a single still-image demuxer. A file disguised as a playlist
        # must never be able to open neighbouring files.
        with path.open("rb") as source:
            head = source.read(12)
        if head.startswith(b"\xff\xd8\xff"):
            demuxer = "jpeg_pipe"
        elif head.startswith(b"\x89PNG\r\n\x1a\n"):
            demuxer = "png_pipe"
        elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            demuxer = "webp_pipe"
        else:
            raise ValueError("INVALID_IMAGE")
        args = ["-f", demuxer, "-protocol_whitelist", "file", "-max_pixels", "16777216"]
    else:
        args = ["-ss", str(second), *MEDIA_INPUT]
    run(
        [
            *FFMPEG,
            *args,
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
        write_frame(path, image, second)
        rows.append({"id": name, "timestamp": second, "imagePath": image.name})
    return rows


def album_frames(
    directory: Path, count: int, limit: int, max_frames: int
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    elapsed = 0.0
    for page in range(1, count + 1):
        prefix = f".page-{page:03}"
        poster = directory / (prefix + ".img")
        clip = directory / (prefix + ".mp4")
        samples: list[tuple[Path, float | None]] = [(poster, None)]
        if clip.exists():
            duration, _ = probe(clip, limit)
            elapsed += duration
            if elapsed > limit:
                raise WorkerProblem("DURATION_LIMIT", seconds=elapsed)
            samples.extend([(clip, 0.0), (clip, duration * 0.65)])
        if len(rows) + len(samples) > max_frames:
            raise ValueError("IMAGE_LIMIT")
        for source, second in samples:
            name = f"f{len(rows):03}"
            image = directory / (name + ".jpg")
            write_frame(source, image, second)
            rows.append(
                {"id": name, "page": page, "timestamp": second, "imagePath": image.name}
            )
    return rows


def read_ocr(
    directory: Path,
    images: list[dict[str, Any]],
    language: str,
    platform: str,
    duration: float | None,
) -> list[dict[str, Any]]:
    event("OCR")
    pages = []
    for image in images:
        tsv = run(
            [
                "tesseract",
                str((directory / image["imagePath"]).resolve()),
                "stdout",
                "-l",
                language,
                "--psm",
                "11",
                "tsv",
            ],
            60,
        ).decode()
        pages.append(parse_lines(tsv))
    return summarize(images, pages, platform, duration)


def process(directory: Path, options: argparse.Namespace) -> dict[str, Any]:
    prompt = os.environ.get("MEDIA_LENS_ASR_PROMPT", "")
    processing = {
        "requestedModel": options.model,
        "requestedDevice": options.device,
        "asrFallback": not options.no_asr_fallback,
        "promptConfigured": bool(prompt),
        "maxFrames": options.max_frames,
        "maxSeconds": options.max_seconds,
        "interval": options.interval,
        "ocrLang": options.ocr_lang,
        "beamSize": 3,
        "vadFilter": True,
    }
    if options.album_pages:
        if not 1 <= options.album_pages <= options.max_frames:
            raise ValueError("IMAGE_LIMIT")
        event("EXTRACTING_FRAMES")
        images = album_frames(
            directory, options.album_pages, options.max_seconds, options.max_frames
        )
        return {
            "duration": None,
            "processing": processing,
            "warnings": [],
            "transcript": {
                "status": "not_applicable",
                "language": None,
                "text": "",
                "segments": [],
            },
            "frames": images,
            "ocr": read_ocr(
                directory, images, options.ocr_lang, options.platform, None
            ),
        }
    path = directory / (".playback.mp4" if options.temporary_playback else "source.mp4")
    event("EXTRACTING_AUDIO")
    duration, audio = probe(path, options.max_seconds)
    transcript: dict[str, Any] = {
        "status": "no_audio",
        "language": None,
        "text": "",
        "segments": [],
    }
    warnings: list[str] = []
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
            try:
                transcript = transcribe(
                    wav,
                    options.model,
                    options.device,
                    not options.no_asr_fallback,
                    prompt,
                    duration,
                )
                if transcript.get("warning"):
                    warnings.append(transcript["warning"])
            except ImportError:
                warnings.append("ASR_FAILED")
                transcript.update(status="unavailable", warning="ASR_FAILED")
            except WorkerProblem as exc:
                if str(exc) not in {"MODEL_UNAVAILABLE", "ASR_FAILED"}:
                    raise
                warnings.append(str(exc))
                transcript.update(status="unavailable", warning=str(exc))
    finally:
        wav.unlink(missing_ok=True)
    event("EXTRACTING_FRAMES")
    images = frames(path, directory, duration, options.interval, options.max_frames)
    ocr = read_ocr(directory, images, options.ocr_lang, options.platform, duration)
    return {
        "duration": duration,
        "processing": processing,
        "warnings": warnings,
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
    parser.add_argument("--no-asr-fallback", action="store_true")
    parser.add_argument("--platform", choices=["douyin", "bilibili", "xiaohongshu"])
    parser.add_argument("--album-pages", type=int, default=0)
    parser.add_argument("--temporary-playback", action="store_true")
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
    except WorkerProblem as problem:
        print(json.dumps({"error": str(problem), **problem.fields}), flush=True)
        return 1
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        subprocess.SubprocessError,
    ) as exc:
        codes = {
            "DURATION_LIMIT",
            "INVALID_VIDEO",
            "IMAGE_LIMIT",
            "INVALID_OPTIONS",
            "INVALID_IMAGE",
        }
        code = (
            str(exc)
            if isinstance(exc, ValueError) and str(exc) in codes
            else "WORKER_FAILED"
        )
        print(json.dumps({"error": code, "type": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
