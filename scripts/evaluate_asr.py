"""Compare local CPU models and vocabulary prompts against an independent reference."""

import argparse
import json
import math
import os
import subprocess
import sys
import time
import unicodedata
import wave
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))
from media_worker import transcribe


def normalize(text: str, simplify: bool = False) -> str:
    if simplify and text:
        text = subprocess.run(
            ["uconv", "-x", "Traditional-Simplified"],
            input=text,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    return "".join(
        c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum()
    )


def distance(reference: str, actual: str) -> int:
    row = list(range(len(actual) + 1))
    for i, expected in enumerate(reference, start=1):
        nxt = [i]
        for j, got in enumerate(actual, start=1):
            nxt.append(min(nxt[-1] + 1, row[j] + 1, row[j - 1] + (expected != got)))
        row = nxt
    return row[-1]


def score(
    reference: str, hypothesis: str, words: list[str], simplify: bool
) -> Counter[str]:
    got = normalize(hypothesis, simplify)
    return Counter(
        edits=distance(reference, got),
        referenceChars=len(reference),
        termHits=sum(w in reference and w in got for w in words),
        termOpportunities=sum(w in reference for w in words),
        unexpectedTerms=sum(w not in reference and w in got for w in words),
        punctuation=sum(unicodedata.category(c).startswith("P") for c in hypothesis),
        sentenceMarks=sum(c in ".!?。！？" for c in hypothesis),
    )


def vocabulary(vocab: list[str], simplify: bool) -> list[str]:
    if (
        not isinstance(vocab, list)
        or not vocab
        or not all(isinstance(w, str) for w in vocab)
    ):
        raise ValueError("vocabulary must be a nonempty list of words")
    words = [normalize(w, simplify) for w in vocab]
    if "" in words or len(set(words)) != len(words):
        raise ValueError("expected distinct nonempty vocabulary terms")
    return words


def score_recording(manifest: Path, transcript: Path, simplify: bool) -> dict:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    words = vocabulary(data["vocabulary"], simplify)
    recognized = json.loads(transcript.read_text(encoding="utf-8"))
    if recognized.get("status") not in {"ok", "no_speech"}:
        raise ValueError("requires a completed transcript")
    previous_end = 0.0
    totals: Counter[str] = Counter()
    windows = []
    for window in data["windows"]:
        start, end = window["start"], window["end"]
        ref = normalize(window["reference"], simplify)
        if not ref or not (previous_end <= start < end and math.isfinite(end)):
            raise ValueError("expected ordered nonoverlapping windows with a reference")
        previous_end = end
        text = "".join(
            s["text"]
            for s in recognized["segments"]
            if start <= (s["start"] + s["end"]) / 2 < end
        )
        counts = score(ref, text, words, simplify)
        totals.update(counts)
        windows.append(dict(start=start, end=end, **counts))
    if not windows:
        raise ValueError("no reference windows")
    return dict(
        windows=windows,
        **totals,
        cer=round(totals["edits"] / totals["referenceChars"], 4),
    )


def evaluate(manifest: Path, simplify: bool) -> list[dict[str, str | int | float]]:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    vocab = data["vocabulary"]
    words = vocabulary(vocab, simplify)
    prompt = "、".join(vocab) + "。"
    if len(prompt) > 512:
        raise ValueError(
            "use distinct nonempty terms and a prompt of at most 512 characters"
        )
    prompts = {"none": "", "vocabulary": prompt}
    if "stylePrompt" in data:
        style = data["stylePrompt"]
        if not isinstance(style, str) or not style.strip() or len(style) > 512:
            raise ValueError("stylePrompt must contain 1 to 512 characters")
        prompts["style"] = style

    clips: dict[Path, tuple[float, str]] = {}
    for item in data["clips"]:
        path = (manifest.parent / item["wav"]).resolve()
        ref = normalize(item["reference"], simplify)
        if not ref or path in clips:
            raise ValueError("each clip needs a distinct WAV and a nonempty reference")
        with wave.open(str(path), "rb") as wav:
            if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (
                1,
                16000,
                2,
            ) or not wav.getnframes():
                raise ValueError("expected nonempty mono 16 kHz 16-bit PCM WAV")
            clips[path] = (wav.getnframes() / 16000, ref)
    if not clips:
        raise ValueError("no clips supplied")

    rows: list[dict[str, str | int | float]] = []
    for model in ("base", "small"):
        for mode, hint in prompts.items():
            totals: Counter[str] = Counter()
            elapsed = 0.0
            for path, (duration, ref) in clips.items():
                start = time.perf_counter()
                result = transcribe(path, model, "cpu", False, hint, duration)
                elapsed += time.perf_counter() - start
                if result["model"] != model or result["status"] not in {
                    "ok",
                    "no_speech",
                }:
                    raise ValueError(
                        "comparison requires the requested model and a completed transcript"
                    )
                totals.update(score(ref, result["text"], words, simplify))
            rows.append(
                dict(
                    model=model,
                    promptMode=mode,
                    clips=len(clips),
                    audioSeconds=round(sum(d for d, _ in clips.values()), 3),
                    **totals,
                    cer=round(totals["edits"] / totals["referenceChars"], 4),
                    wallSeconds=round(elapsed, 2),
                )
            )
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--simplify",
        action="store_true",
        help="use ICU uconv to compare Han scripts equally",
    )
    parser.add_argument(
        "--score-transcript",
        type=Path,
        help="score marked windows in a complete transcript.json without cutting the audio",
    )
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"  # set before the worker imports faster-whisper
    report = (
        score_recording(args.manifest, args.score_transcript, args.simplify)
        if args.score_transcript
        else evaluate(args.manifest, args.simplify)
    )
    print(json.dumps(report, indent=2))
