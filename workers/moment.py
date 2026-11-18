"""Decode the displayed video frame and inspect the surrounding audio of a local MP4."""

from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
import numpy as np
from av.stream import Disposition
from media_worker import FFMPEG, MEDIA_INPUT, WorkerProblem, probe, run


def write_displayed_frame(
    path: Path, image: Path, second: float
) -> tuple[float, float]:
    # Use the presentation clock of the whole work, including audio/video offsets.
    options = dict(zip(MEDIA_INPUT[::2], MEDIA_INPUT[1::2], strict=True))
    with av.open(
        str(path), "r", format="mov", options={k[1:]: v for k, v in options.items()}
    ) as media:
        video = next(
            (
                s
                for s in media.streams.video
                if not s.disposition & Disposition.attached_pic
            ),
            None,
        )
        if video is None:
            raise WorkerProblem("INVALID_VIDEO")
        video.codec_context.thread_count = 2
        base = Fraction(video.time_base.numerator, video.time_base.denominator)
        origin = Fraction(media.start_time or 0, av.time_base)
        # Archived Whisper segments start at sample zero of the extracted WAV.
        # Its muxer drops an initial track delay. Map those times to playback.
        audio_offset = 0.0
        if media.streams.audio:
            audio = media.streams.audio[0]
            if audio.start_time is not None:
                audio_offset = float(audio.start_time * audio.time_base) - float(origin)
        target = origin + Fraction(str(second))
        first_tick = video.start_time or 0
        # MP4 can index a B-frame GOP by decode time. A backward seek may land
        # on a keyframe displayed *after* the requested timestamp.
        for tick in dict.fromkeys(
            (
                math.floor(target / base),
                max(first_tick, math.floor((target - 2) / base)),
                first_tick,
            )
        ):
            media.seek(tick, stream=video, backward=True)
            selected = None
            for frame in media.decode(video):
                if frame.pts is None:
                    continue
                if frame.pts * base > target:
                    break
                selected = frame
            else:
                # The audio track can continue after the final video frame expires.
                if selected is not None and selected.pts is not None:
                    end = (
                        video.start_time + video.duration
                        if video.start_time is not None and video.duration is not None
                        else selected.pts + selected.duration
                    )
                    if end * base <= target:
                        raise WorkerProblem("NO_FRAME_AT_TIME")
            if selected is not None:
                break
        if selected is None or selected.pts is None:
            raise WorkerProblem("NO_FRAME_AT_TIME")
        pts = selected.pts * base - origin
        scale = min(1.0, 1280 / max(selected.width, selected.height))
        frame = selected.reformat(
            width=max(1, round(selected.width * scale)),
            height=max(1, round(selected.height * scale)),
            format="rgb24",
        )
        if selected.rotation:
            frame = av.VideoFrame.from_ndarray(
                np.rot90(frame.to_ndarray(), selected.rotation // 90).copy(),
                format="rgb24",
            )
        frame.save(image)
        if image.stat().st_size > 512_000:
            frame.reformat(
                width=max(1, frame.width // 2), height=max(1, frame.height // 2)
            ).save(image)
        if not 0 < image.stat().st_size <= 512_000:
            raise WorkerProblem("IMAGE_LIMIT")
        return float(pts), audio_offset


def audio_window(
    path: Path, directory: Path, second: float, duration: float, include: bool
) -> dict[str, Any]:
    # Accurate input seek resets timestamps to the window origin. Pad a late audio
    # stream so sample zero is the start of the requested interval.
    start, end = max(0.0, second - 2), min(duration, second + 2)
    pcm = run(
        [
            *FFMPEG,
            "-ss",
            str(start),
            *MEDIA_INPUT,
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-vn",
            "-t",
            str(end - start),
            "-ac",
            "1",
            "-af",
            "aresample=16000:async=1:first_pts=0",
            "-f",
            "s16le",
            "-",
        ]
    )
    count = round((end - start) * 16000)
    pcm = pcm[: count * 2].ljust(count * 2, b"\0")
    if include:
        with wave.open(str(directory / "audio.wav"), "wb") as clip:
            clip.setparams((1, 2, 16000, 0, "NONE", ""))
            clip.writeframes(pcm)
    try:
        from faster_whisper.vad import get_speech_timestamps

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        spans = [
            {"start": start + row["start"] / 16000, "end": start + row["end"] / 16000}
            for row in get_speech_timestamps(
                samples, min_silence_duration_ms=200, speech_pad_ms=80
            )
        ]
    except (ImportError, OSError, RuntimeError, ValueError):
        return {"start": start, "end": end, "activityAtTimestamp": "unavailable"}
    detected = any(s["start"] <= second < s["end"] for s in spans)
    return {
        "start": start,
        "end": end,
        "activityAtTimestamp": "detected" if detected else "not_detected",
        "speechIntervals": spans,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("second", type=float)
    parser.add_argument("limit", type=int)
    parser.add_argument("--audio", action="store_true")
    args = parser.parse_args()
    directory = args.directory
    path = directory / ".playback.mp4"
    duration, has_audio = probe(path, args.limit)
    if not 0 <= args.second < duration:
        raise WorkerProblem("NO_FRAME_AT_TIME")
    timestamp, audio_offset = write_displayed_frame(
        path, directory / "f000.jpg", args.second
    )
    speech: dict[str, Any] = {"activityAtTimestamp": "no_audio"}
    if has_audio:
        try:
            speech = audio_window(path, directory, args.second, duration, args.audio)
        except (ImportError, OSError, ValueError, RuntimeError):
            speech = {"activityAtTimestamp": "unavailable"}
    print(
        json.dumps(
            {
                "duration": duration,
                "timestamp": timestamp,
                "transcriptOffset": audio_offset,
                "speech": speech,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except WorkerProblem as exc:
        print(json.dumps({"error": str(exc), **exc.fields}))
        sys.exit(1)
