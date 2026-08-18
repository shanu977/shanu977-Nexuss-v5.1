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

``ReasoningFilter`` is the streaming-safe counterpart: feed it the chunks of an
in-progress response with ``push()`` and it emits only the final-answer portion,
holding state across chunk boundaries (including markers split across chunks).
``flush()`` returns any remaining visible text when the stream ends; internal
reasoning is never exposed.
"""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Streaming filter
# ---------------------------------------------------------------------------
# `\r` is included in the whitespace classes so CRLF line endings (rare but
# possible in provider output) are recognized the same as LF: otherwise a
# "thinking"/"response" marker on a `\r\n` line would not match and the
# internal reasoning would leak.

_MAX_MARKER = 24

_ANGLE_MARKER_RE = re.compile(
    r"<\s*\/?\s*(thinking|think|response)\s*>", re.IGNORECASE
)
_BARE_LINE_MARKER_RE = re.compile(
    r"^[ \t\r]*(thinking|response)[ \t\r]*$", re.MULTILINE | re.IGNORECASE
)
_TRAILING_WHITESPACE = re.compile(r"[\t \r\n]+$")
_LEADING_WHITESPACE = re.compile(r"^[\t \r\n]+")

_WAIT = object()


def _classify_angle_tag(tag: str) -> str:
    closing = re.match(r"^<\s*/", tag) is not None
    name = re.sub(r"^<\s*\/?\s*", "", tag)
    name = re.sub(r"\s*>$", "", name).lower()
    if (name == "thinking" or name == "think") and not closing:
        return "open"
    return "close"


def _is_tag_prefix(candidate: str) -> bool:
    if not candidate.startswith("<"):
        return False
    body = candidate[1:]
    m = re.match(r"^(\s*)(/?)(\s*)([a-z]*)(\s*)$", body, re.IGNORECASE)
    if not m:
        return False
    letters = m.group(4).lower()
    return any(
        word.startswith(letters) and len(letters) <= len(word)
        for word in ("thinking", "think", "response")
    )


def _is_bare_line_prefix(line: str) -> bool:
    t = line.strip().lower()
    if t == "":
        return True
    return (len(t) <= len("thinking") and "thinking".startswith(t)) or (
        len(t) <= len("response") and "response".startswith(t)
    )


def _find_stream_marker(text: str, close_only: bool = False) -> tuple | None:
    """Return ``(start, end, type)`` for the earliest reasoning marker.

    When ``close_only`` is true, open markers are ignored (used while already
    inside a thinking block).
    """
    best: tuple | None = None

    angle = _ANGLE_MARKER_RE.search(text)
    if angle:
        typ = _classify_angle_tag(angle.group(0))
        if not close_only or typ == "close":
            best = (angle.start(), angle.end(), typ)

    bare = _BARE_LINE_MARKER_RE.search(text)
    if bare:
        typ = "open" if bare.group(1).strip().lower() == "thinking" else "close"
        if not close_only or typ == "close":
            end = bare.end()
            if end < len(text) and text[end] == "\n":
                end += 1
            candidate = (bare.start(), end, typ)
            if best is None or candidate[0] < best[0]:
                best = candidate

    return best


def _partial_marker_at(text: str) -> int | None:
    """Index in ``text`` from which the tail could still become a reasoning
    marker, or None when nothing is pending."""
    hold: int | None = None

    lt = text.rfind("<")
    if lt != -1:
        suffix = text[lt:]
        if ">" not in suffix and len(suffix) <= _MAX_MARKER and _is_tag_prefix(suffix):
            hold = lt

    nl = text.rfind("\n")
    line = text[nl + 1 :]
    if len(line) <= _MAX_MARKER and _is_bare_line_prefix(line):
        line_hold = nl + 1
        hold = line_hold if hold is None else min(hold, line_hold)

    return hold


class ReasoningFilter:
    """Streaming-safe reasoning filter (mirrors the frontend implementation).

    Feed response chunks with ``push()``; the returned string is the visible
    (non-reasoning) portion for that chunk, with state maintained across chunk
    boundaries. ``flush()`` releases any remaining visible text when the stream
    ends; reasoning is never exposed.
    """

    def __init__(self) -> None:
        self.state = "normal"
        self.pending = ""
        self.emitted = False

    def push(self, chunk: str) -> str:
        self.pending += chunk
        out: list[str] = []
        guard = 0
        while self.pending and guard < 10_000:
            guard += 1
            result = self._step()
            if result is _WAIT:
                break
            if result:
                self.emitted = True
            out.append(result)
        return "".join(out)

    def flush(self) -> str:
        if self.state == "thinking":
            self.pending = ""
            return ""

        out = self.pending
        self.pending = ""

        incomplete = re.search(
            r"<\s*\/?\s*(thinking|think|response)\s*$", out, re.IGNORECASE
        )
        if incomplete:
            out = out[: incomplete.start()]
            out = _TRAILING_WHITESPACE.sub("", out)

        nl = out.rfind("\n")
        last_line = out[nl + 1 :].strip().lower()
        if last_line in ("thinking", "response"):
            out = out[:nl] if nl >= 0 else ""

        if out:
            self.emitted = True
        return out

    def _step(self) -> str | object:
        if not self.pending:
            return _WAIT

        if self.state == "normal":
            marker = _find_stream_marker(self.pending)
            if marker is not None:
                start, end, typ = marker
                marker_at_end = end == len(self.pending)
                prefix = self.pending[:start]
                self.pending = self.pending[end:]
                if typ == "open":
                    if not self.emitted and prefix.strip() == "":
                        prefix = ""
                    if marker_at_end:
                        prefix = _TRAILING_WHITESPACE.sub("", prefix)
                    self.state = "thinking"
                else:
                    self.pending = _LEADING_WHITESPACE.sub("", self.pending)
                return prefix

            hold = _partial_marker_at(self.pending)
            if hold is None:
                all_pending = self.pending
                self.pending = ""
                return all_pending
            if hold > 0:
                prefix = self.pending[:hold]
                ws = _TRAILING_WHITESPACE.search(prefix)
                if ws:
                    prefix = prefix[: ws.start()]
                    self.pending = self.pending[ws.start() :]
                else:
                    self.pending = self.pending[hold:]
                if not prefix:
                    return _WAIT
                return prefix
            if len(self.pending) > _MAX_MARKER:
                all_pending = self.pending
                self.pending = ""
                return all_pending
            return _WAIT

        # THINKING state: discard everything until a close marker completes.
        close = _find_stream_marker(self.pending, close_only=True)
        if close is not None:
            self.pending = self.pending[close[1]:]
            self.pending = _LEADING_WHITESPACE.sub("", self.pending)
            self.state = "normal"
            return ""

        hold = _partial_marker_at(self.pending)
        if hold is None:
            self.pending = ""
            return ""
        self.pending = self.pending[hold:]
        if len(self.pending) > _MAX_MARKER:
            self.pending = ""
        return ""


def filter_reasoning(text: str) -> str:
    """Strip internal reasoning markers and blocks from a complete reply.

    Delegates to the streaming filter so the batch and per-chunk paths behave
    identically (matching the frontend's ``ReasoningFilter``).
    """
    filter_ = ReasoningFilter()
    return (filter_.push(text) + filter_.flush()).strip()