import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))
from ocr_evidence import parse_lines, summarize


def tsv(*rows):
    entries = ["header", "1\t1\t0\t0\t0\t0\t0\t0\t500\t1000\t-1\t"]
    for i, (x, y, text, score) in enumerate(rows, 1):
        for word, token in enumerate(text.split(), 1):
            entries.append(
                f"5\t1\t1\t1\t{i}\t{word}\t{x + word * 2}\t{y}\t10\t10\t{score}\t{token}"
            )
    return parse_lines("\n".join(entries))


def summary(frames, platform="douyin", album=False):
    images = [
        {
            "timestamp": None if album else i,
            "id": f"f{i:03}",
            **({"page": i + 1} if album else {}),
        }
        for i in range(len(frames))
    ]
    return summarize(images, frames, platform, None if album else 10)


def test_moving_overlay_and_clipped_digits_preserve_nearby_caption():
    frames = []
    for i, (x, y) in enumerate([(15, 50), (15, 50), (410, 860), (410, 860)]):
        handle = "Q ArtistStudio" if i % 2 == 0 else "Q ArtistSt"
        frames.append(
            tsv(
                (x, y, handle, 95),
                (x, y + 30, "12345678" if i % 2 == 0 else "1234567", 92),
                (x, y + 16, "1538 °C", 93),
                (x, y + 20, "2026", 95),
                (210, 500, "12345678", 91),
            )
        )
    rows = summary(frames)
    for row in rows:
        assert row["text"].splitlines() == ["1538 °C", "2026", "12345678"]
        assert row["foldedLines"] == {"possibleOverlay": 2, "shortUncertain": 0}
        assert "Q Artist" in row["rawText"]
    for other in [
        summary(frames, "bilibili"),
        summary(frames, album=True),
        summary(frames[:1]),
    ]:
        assert all(
            "Q Artist" in r["text"] and not r["foldedLines"]["possibleOverlay"]
            for r in other
        )


def test_fold_uncertain_short_lines_but_keep_context_and_raw_readings():
    page = tsv(
        (0, 0, "GA", 60.3),
        (50, 100, "*7", 74.4),
        (50, 200, "fl", 66.9),
        (50, 300, "7", 90.1),
        (20, 400, "AI", 94),
        (110, 450, "5G", 94),
        (200, 480, "2:1", 72),
        (250, 550, "8%", 70),
        (80, 600, "Level", 90),
        (115, 600, "7", 94),
        (200, 800, "火", 97),
    )
    row = summary([page])[0]
    assert row["text"].splitlines() == ["AI", "5G", "2:1", "8%", "Level", "7", "火"]
    assert row["foldedLines"]["shortUncertain"] == 4
    assert all(s in row["rawText"].splitlines() for s in ("GA", "*7", "fl"))
    assert row["rawText"].splitlines().count("7") == 2
