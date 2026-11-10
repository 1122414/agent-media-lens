import json
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import evaluate_asr as evaluation


def test_edit_counts_and_prompt_leak_are_separate() -> None:
    reference = evaluation.normalize("设置ＡＰＩ，保存。")
    scores = evaluation.score(reference, "设置Api！另存", ["api", "另存"], False)
    assert scores == {
        "edits": 1,
        "referenceChars": 7,
        "termHits": 1,
        "termOpportunities": 1,
        "unexpectedTerms": 1,
        "punctuation": 1,
        "sentenceMarks": 1,
    }
    assert evaluation.distance("甲乙", "") == 2
    assert evaluation.distance("甲乙", "甲乙丙") == 1


def fixture_manifest(tmp_path, clips):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"vocabulary": ["甲"], "clips": clips}))
    return path


def make_wav(path, rate=16000):
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", ""))
        wav.writeframes(bytes(3200))


def test_corpus_weighting_counts_missing_speech_and_rejects_fallback(
    tmp_path, monkeypatch
):
    clips = [
        {"wav": "short.wav", "reference": "甲"},
        {"wav": "long.wav", "reference": "乙丙丁"},
    ]
    for clip in clips:
        make_wav(tmp_path / clip["wav"])
    path = fixture_manifest(tmp_path, clips)

    seen = set()

    def transcription(wav, model, device, fallback, prompt, duration):
        seen.add((model, prompt))
        assert fallback is False
        if wav.name == "short.wav":
            return {"status": "no_speech", "text": "", "model": model}
        return {"status": "ok", "text": "乙丙丁", "model": model}

    monkeypatch.setattr(evaluation, "transcribe", transcription)
    rows = evaluation.evaluate(path, False)
    assert len(rows) == 4 and all(r["cer"] == 0.25 for r in rows)
    assert seen == {(m, p) for m in ("base", "small") for p in ("", "甲。")}
    monkeypatch.setattr(
        evaluation,
        "transcribe",
        lambda *args: {"model": "base", "status": "ok", "text": ""},
    )
    with pytest.raises(ValueError, match="requested model"):
        evaluation.evaluate(path, False)


def test_rejects_audio_with_wrong_timebase_before_transcription(tmp_path):
    make_wav(tmp_path / "bad.wav", rate=8000)
    path = fixture_manifest(tmp_path, [{"wav": "bad.wav", "reference": "甲"}])
    with pytest.raises(ValueError, match="16 kHz"):
        evaluation.evaluate(path, False)


def test_score_full_recording_uses_time_and_counts_missed_window(tmp_path):
    ref = tmp_path / "ref.json"
    ref.write_text(
        json.dumps(
            {
                "vocabulary": ["甲"],
                "windows": [
                    {"start": 1, "end": 2, "reference": "甲"},
                    {"start": 10, "end": 11, "reference": "甲乙"},
                ],
            }
        )
    )
    path = tmp_path / "transcript.json"
    path.write_text(
        json.dumps(
            {
                "status": "ok",
                "segments": [
                    {"start": 0, "end": 1, "text": "丙"},
                    {"start": 9, "end": 11, "text": "甲乙"},
                ],
            }
        )
    )
    scores = evaluation.score_recording(ref, path, False)
    assert scores["edits"] == 1 and scores["referenceChars"] == 3
    assert (scores["termHits"], scores["termOpportunities"]) == (1, 2)
