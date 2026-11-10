"""Build a compact OCR view while keeping every original word in rawText."""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Line:
    raw: str
    text: str
    scores: tuple[float, ...]
    x: float
    y: float

    @property
    def corner(self) -> tuple[bool, bool] | None:
        if (0 <= self.x <= 0.37 or self.x >= 0.63) and (
            0 <= self.y <= 0.18 or self.y >= 0.82
        ):
            return self.x > 0.5, self.y > 0.5
        return None


def parse_lines(tsv: str) -> list[Line]:
    groups: dict[tuple[str, ...], list[tuple[str, float, int, int, int, int]]] = (
        defaultdict(list)
    )
    width = height = 0
    for row in tsv.splitlines()[1:]:
        f = row.split("\t", 11)
        if len(f) != 12:
            continue
        if f[0] == "1":
            width, height = int(f[8]), int(f[9])
        if f[0] == "5" and f[11].strip():
            x, y, w, h = map(int, f[6:10])
            groups[tuple(f[1:5])].append(
                (f[11].strip(), float(f[10]), x, y, x + w, y + h)
            )
    lines = []
    for words in groups.values():
        raw = " ".join(w[0] for w in words)
        scores = tuple(w[1] for w in words if w[1] >= 60)
        pieces: list[str] = []
        for word, conf, *_box in words:
            if conf >= 60:
                pieces.append(word)
            elif not pieces or pieces[-1] != "…":
                pieces.append("…")
        text = " ".join(pieces)
        if not any(c.isalnum() for c in text):
            text = ""
        center_x = (
            (min(w[2] for w in words) + max(w[4] for w in words)) / (2 * width)
            if width
            else -1
        )
        center_y = (
            (min(w[3] for w in words) + max(w[5] for w in words)) / (2 * height)
            if height
            else -1
        )
        lines.append(Line(raw, text, scores, center_x, center_y))
    return lines


def anchor_key(raw: str) -> str:
    if re.fullmatch(r".?音号[:：]\d*", "".join(raw.split())):
        return "account:"
    # The magnifying-glass icon often reads as a separate Q. A prefix
    # matches a truncated handle, but only recurrences near the same spot count.
    handle = re.fullmatch(r"[Q⚲]\s+([\w.-]{3,64})", raw)
    return "handle:" + handle[1][:3].casefold() if handle else ""


def overlay_anchors(
    pages: list[list[Line]],
) -> dict[tuple[bool, bool], list[tuple[int, Line]]]:
    groups: dict[tuple[tuple[bool, bool], str], list[tuple[int, Line]]] = defaultdict(
        list
    )
    for i, lines in enumerate(pages):
        for line in lines:
            key = anchor_key(line.raw)
            if key and line.corner is not None:
                groups[(line.corner, key)].append((i, line))
    confirmed: dict[tuple[bool, bool], list[tuple[int, Line]]] = defaultdict(list)
    for (corner, _), observations in groups.items():
        for i, line in observations:
            if any(
                i != j
                and abs(line.x - other.x) < 0.12
                and abs(line.y - other.y) < 0.035
                for j, other in observations
            ):
                confirmed[corner].append((i, line))
    return confirmed


@dataclass(frozen=True)
class AccountRead:
    frame: int
    line: Line
    digits: str


def account_digits(line: Line) -> str:
    match = re.fullmatch(
        r"(?:[A-Za-z]{1,4}[:：]|.?音号[:：])?(\d+)[;:'\"：]?", "".join(line.raw.split())
    )
    return match[1] if match else ""


def account_reads(
    pages: list[list[Line]], anchors: dict[tuple[bool, bool], list[tuple[int, Line]]]
) -> list[AccountRead]:
    reads = []
    for i, lines in enumerate(pages):
        for line in lines:
            if line.corner is None:
                continue
            digits = account_digits(line)
            if len(digits) >= 5 and any(
                abs(i - j) <= 2
                and abs(line.y - a.y) < 0.056
                and abs(line.x - a.x) < 0.16
                for j, a in anchors.get(line.corner, ())
            ):
                reads.append(AccountRead(i, line, digits))
    return reads


def overlay(
    line: Line,
    frame: int,
    anchors: dict[tuple[bool, bool], list[tuple[int, Line]]],
    reads: list[AccountRead],
) -> bool:
    if line.corner is None:
        return False
    same_corner = anchors.get(line.corner, ())
    if not same_corner:
        return False
    near = [
        a
        for j, a in same_corner
        if abs(frame - j) <= 2
        and abs(line.x - a.x) < 0.16
        and abs(line.y - a.y) < 0.056
    ]
    key = anchor_key(line.raw)
    if key and (
        near
        or (
            key == "account:"
            and any(
                abs(line.y - a.y) < 0.056 and abs(line.x - a.x) < 0.16
                for _, a in same_corner
            )
        )
    ):
        return True
    digits = account_digits(line)
    if digits:
        # Require either a nearby recurring handle, or the same account-number
        # row and a matching digit prefix. A number elsewhere is not a watermark.
        if len(digits) <= 2:
            return bool(near) and any(
                len(digits) == 2 and digits in r.digits for r in reads
            )
        return len(digits) >= 3 and any(
            r.frame != frame
            and r.line.corner == line.corner
            and abs(r.line.x - line.x) < 0.12
            and abs(r.line.y - line.y) < 0.02
            and digits[:3] == r.digits[:3]
            for r in reads
        )
    fragment = "".join(c for c in line.text.casefold() if c.isalnum())
    return len(fragment) >= 3 and any(
        abs(a.y - line.y) < 0.025
        and abs(a.x - line.x) < 0.12
        and anchor_key(a.raw).startswith("handle:")
        and fragment in "".join(a.raw.split()).casefold()
        for _, a in same_corner
    )


def outro_account(line: Line, frame: int, reads: list[AccountRead]) -> bool:
    # Cards put the account in the middle. A legible explicit label is sufficient;
    # a damaged label needs the exact digits from an earlier corner watermark.
    if re.fullmatch(r"抖音号[:：][0-9]+", "".join(line.raw.split())):
        return True
    digits = account_digits(line)
    return (
        bool(digits)
        and line.text.replace("…", "").strip() == digits
        and any(r.frame < frame and r.digits == digits for r in reads)
    )


def short_noise(line: Line, nearby: list[Line]) -> bool:
    text = line.text.replace("…", "").strip()
    chars = [c for c in text if c.isalnum()]
    if len(chars) > 2 or not chars:
        return False
    # Short scores, signed values, temperatures and percentages carry context
    # in their own punctuation. Keep them even if they occur only once.
    if re.fullmatch(r"(?:\d\s*[:：/-]\s*\d|[+-]\d{1,2}|\d{1,2}\s*[%°℃])", text):
        return False
    score = sum(line.scores) / len(line.scores)
    if (
        score >= 85
        and (len(chars) == 2 or not chars[0].isascii())
        and (text.isalnum() or text == " ".join(chars))
    ):
        return False
    return not (
        score >= 85
        and any(
            other is not line
            and line.x >= 0
            and abs(other.x - line.x) < 0.22
            and abs(other.y - line.y) < 0.035
            and sum(c.isalnum() for c in other.text) >= 3
            for other in nearby
        )
    )


def summarize(
    images: list[dict[str, Any]],
    pages: list[list[Line]],
    platform: str,
    duration: float | None,
) -> list[dict[str, Any]]:
    anchors = overlay_anchors(pages) if platform == "douyin" and duration else {}
    reads = account_reads(pages, anchors) if anchors else []
    rows = []
    seen: dict[tuple[int | None, str], str] = {}
    for i, (image, lines) in enumerate(zip(images, pages, strict=True)):
        raw = "\n".join(line.raw for line in lines)[:16000]
        sec = image["timestamp"]
        is_outro = bool(
            duration
            and platform == "douyin"
            and sec is not None
            and sec >= duration - min(6, duration * 0.15)
            and "发现更多创作者" in "".join(raw.split())
        )
        if is_outro:
            image["role"] = "possible_platform_outro"
        kept: list[str] = []
        scores: list[float] = []
        overlay_count = short_count = 0
        for n, line in enumerate(lines):
            if not line.text:
                continue
            if overlay(line, i, anchors, reads) or (
                is_outro and outro_account(line, i, reads)
            ):
                overlay_count += 1
            elif short_noise(line, lines[max(0, n - 3) : n + 4]):
                short_count += 1
            else:
                kept.append(line.text)
                scores.extend(line.scores)
        text = "\n".join(kept)[:16000]
        row = {
            **({"page": image["page"]} if "page" in image else {}),
            "timestamp": sec,
            "frameId": image["id"],
            "text": text,
            "rawText": raw,
            "confidence": round(sum(scores) / len(scores), 1) if scores else None,
            "foldedLines": {
                "possibleOverlay": overlay_count,
                "shortUncertain": short_count,
            },
        }
        key = (image.get("page"), text)
        if text:
            if key in seen:
                row["repeatedOf"] = seen[key]
            else:
                seen[key] = image["id"]
        rows.append(row)
    return rows
