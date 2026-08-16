"""Filter internal reasoning markers out of model replies.

The configured thinking-capable models (notably the Qwen3 vision model
`qwen/qwen3.6-27b`) return their chain of thought inline in the reply, delimited
by reasoning markers. They arrive either as bare lines::

    thinking
    <internal reasoning>
    response
    <final answer>

or as angle-bracket tags (``<thinking>`` / ``</thinking>``, ``<response>`` /
``</response>``, ``<THINK>``, ...) in case/whitespace variants.

``filter_reasoning`` removes recognized reasoning markup and the text inside a
reasoning block while never removing the actual answer. The frontend applies the
same filter to what it persists; this backend copy is defense-in-depth so the
raw API never returns reasoning to any client.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_ANGLE_RE = re.compile(r"<\s*/?\s*(?:thinking|think|response)\s*>", re.IGNORECASE)
_BARE_LINE_RE = re.compile(
    r"^[ \t]*(thinking|response)[ \t]*$", re.MULTILINE | re.IGNORECASE
)
_LEADING_WS_RE = re.compile(r"^[ \t\r\n]+")
_OPEN_NAMES = frozenset({"thinking", "think"})


@dataclass
class _Marker:
    start: int
    end: int
    open: bool


def _is_open_angle(tag: str) -> bool:
    if re.match(r"^<\s*/", tag):
        return False
    name = re.sub(r"^<\s*/?\s*", "", tag)
    name = re.sub(r"\s*>$", "", name).lower()
    return name in _OPEN_NAMES


def _find_marker(text: str, start: int) -> _Marker | None:
    """Return the earliest reasoning marker at or after ``start``, if any."""
    best: _Marker | None = None

    angle = _ANGLE_RE.search(text, start)
    if angle:
        best = _Marker(angle.start(), angle.end(), _is_open_angle(angle.group(0)))

    bare = _BARE_LINE_RE.search(text, start)
    if bare:
        end = bare.end()
        if end < len(text) and text[end] == "\n":
            end += 1
        open_ = bare.group(1).strip().lower() == "thinking"
        candidate = _Marker(bare.start(), end, open_)
        if best is None or candidate.start < best.start:
            best = candidate

    return best


def filter_reasoning(text: str) -> str:
    """Strip internal reasoning markers and blocks from a complete reply."""
    out: list[str] = []
    pos = 0
    thinking = False

    while True:
        marker = _find_marker(text, pos)
        if marker is None:
            # Never expose the tail of an unclosed reasoning block.
            if not thinking:
                out.append(text[pos:])
            break

        if thinking:
            # While inside a block only a close marker ends it; any other open
            # marker is ignored as part of the reasoning.
            if marker.open:
                pos = marker.end
                continue
            pos = marker.end
            skip = _LEADING_WS_RE.match(text, pos)
            if skip:
                pos = skip.end()
            thinking = False
            continue

        if marker.open:
            # Start of a reasoning block: keep the answer text before it.
            out.append(text[pos : marker.start])
            pos = marker.end
            thinking = True
        else:
            # A stray reasoning-close boundary: drop the marker and any
            # separator whitespace, but keep what follows it.
            out.append(text[pos : marker.start])
            pos = marker.end
            skip = _LEADING_WS_RE.match(text, pos)
            if skip:
                pos = skip.end()

    return "".join(out).strip()