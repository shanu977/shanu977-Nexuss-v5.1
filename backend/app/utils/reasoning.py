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

# Planning / chain-of-thought heading lines that must never be shown to the user.
# These appear as bare lines like "Strategy: ...", "Draft: ...", "Refine: ..." etc.
# They are stripped as reasoning even when not wrapped in thinking/response markers.
# Also catches numbered headings ("4. Strategy:"), bracket markers ("[Done]"),
# and arrow delimiters like "Output Generation -> \"Hello\"".
#
# The set is deliberately limited to unambiguous internal chain-of-thought
# labels. Ordinary answer structure ("Summary:", "Result:", "Plan:",
# "Steps:", "Conclusion:", "Decision:") is legitimate user-facing content;
# treating it as reasoning used to truncate and mangle real answers
# (everything before/after such a heading was discarded).
_PLANNING_HEADING_RE = re.compile(
    r"^\s*(?:\d+\.\s*)?(?:\*\*|#{1,6}\s*)?\(?\s*"
    r"(Final Output Generation|Output Generation|Final Polish|Internal instructions?|Prompt text|Planning text|Follow Constraints?|Constraints|Checks?|Thought Process|Chain[-\s]?of[-\s]?thought|Self[-\s]?Correction|Strategy|Mental|Draft|Refine|Verification|Analysis|Reasoning|Thought)\b[^:\n]*?\)?\s*(?::|->)\s*.*$"
    r"|^\s*\[.*(?:Done|Proceeds).*?\]\s*$",
    re.IGNORECASE | re.MULTILINE,
)

# Heading names whose after-delimiter text IS the final answer (keep it).
_ANSWER_HEADING_NAMES = {
    "output generation",
    "final output generation",
    "final polish",
}

_WAIT = object()


def _match_planning_heading(line: str) -> tuple[str, str] | None:
    """Match one line as an internal planning heading.

    Returns ``(name, after_delimiter_text)`` or None.
    """
    m = _PLANNING_HEADING_RE.match(line)
    if not m:
        return None
    grp = m.group(1)
    if grp is not None:
        name = grp.strip().lower()
    else:
        low = line.strip().lower()
        name = "done" if "done" in low else "proceeds"
    arrow = line.find("->")
    colon = line.find(":")
    after = ""
    if arrow != -1 and colon != -1:
        after = line[arrow + 2 :] if arrow < colon else line[colon + 1 :]
    elif arrow != -1:
        after = line[arrow + 2 :]
    elif colon != -1:
        after = line[colon + 1 :]
    after = after.strip(" *#\t\r\n\"'✅")
    return name, after


def _strip_freeform_deliberation(text: str) -> str:
    """Strip free-form deliberation that is not heading-based.

    When the visible reply leaked internal back-and-forth ("Let's try...",
    "Final decision: ...", ...), keep the last paragraph that is not itself
    deliberation. The answer is NEVER rewritten into a different fragment
    (e.g. an extracted greeting): replacing a real answer with a generic
    greeting destroys context and is worse than a small leak.
    """
    if not text:
        return text
    # Strip leading markdown artifact ":**" etc.
    # Strip leading "NEXUSS:**" / "NEXUSS :**" / ":**" artifacts that leak from the model
    t = re.sub(r"^\s*(?:NEXUSS\s*:?\s*)?:\*\*\s*", "", text, flags=re.IGNORECASE).strip()
    t = re.sub(r"^\s*:\*\*\s*", "", t).strip()
    if re.search(
        r"Let's try|Let's stick|Actually, the user|Final decision|Refined plan|I will say|I will just|Let's go|Wait,|I should respond|I should acknowledge|should respond with|Follow Constraints|Final Output Generation|Respond only with|Never reveal internal|Be helpful and concise|Acknowledge the friendly|I need to keep it tight",
        t,
        re.IGNORECASE,
    ):
        parts = re.split(r"\n\s*\n", t)
        for p in reversed(parts):
            if not p.strip() or re.search(
                r"Let's try|Let's stick|Actually,|Final decision|Refined plan|I will |Wait,|Okay,|I should|Follow Constraints|Final Output Generation|Respond only with|Never reveal|Acknowledge the friendly",
                p,
                re.IGNORECASE,
            ):
                continue
            cleaned = re.sub(r"^\s*\d+\.\s*", "", p.strip())
            if cleaned:
                return cleaned
        return ""
    return t


def _strip_planning_headings(text: str) -> str:
    """Remove internal planning heading LINES, keeping every other line.

    Only "output generation"-style headings pass their after-delimiter
    content through; all other internal heading lines are dropped whole.
    Surrounding answer content is never discarded.
    """
    if not text or not _PLANNING_HEADING_RE.search(text):
        return _strip_freeform_deliberation(text)
    lines = text.splitlines(True)
    out_parts: list[str] = []
    removed = False
    for line in lines:
        m = _match_planning_heading(line.rstrip("\r\n"))
        if m is None:
            out_parts.append(line)
            continue
        removed = True
        name, after = m
        if name in _ANSWER_HEADING_NAMES and after:
            out_parts.append(after + "\n")
    if not removed:
        return _strip_freeform_deliberation(text)
    joined = "".join(out_parts)
    if joined.startswith("\r\n"):
        joined = joined[2:]
    elif joined.startswith("\n"):
        joined = joined[1:]
    return _strip_freeform_deliberation(joined)


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
        self._plan_buf = ""

    def _is_plan_prefix(self, line: str) -> bool:
        # Hold back lines that look like leaked deliberation (":**", "I should", "Acknowledge")
        if re.search(r":\*\*|I should|Acknowledge the friendly|Follow Constraints|Final Output Generation", line, re.IGNORECASE):
            return True
        t = line.strip().lstrip("*# -").strip()
        # Strip leading numbering like "4. " or bullet "- "
        t = re.sub(r"^\d+\.\s*", "", t).strip()
        t = re.sub(r"^[-*]\s*", "", t).strip()
        # Strip bracket wrapping for prefix check
        t = t.strip("[]").strip()
        t = t.lower()
        if t == "":
            return True
        # Remove possible trailing colon content and parenthetical for prefix check
        first = t.split(":")[0].strip()
        first = re.sub(r"\(.*?\)", "", first).strip()
        # Only unambiguous internal CoT labels are held back. Ordinary answer
        # words (summary/result/plan/steps/...) must stream through untouched.
        candidates = [
            "strategy",
            "mental",
            "draft",
            "refine",
            "self-correction",
            "self correction",
            "verification",
            "analysis",
            "reasoning",
            "chain-of-thought",
            "chain of thought",
            "internal instructions",
            "internal instruction",
            "prompt text",
            "planning text",
            "check against guidelines",
            "checks against guidelines",
            "follow constraints",
            "constraints",
            "final output generation",
            "final polish",
            "output generation",
            "thought process",
            "thought",
        ]
        return any(
            c.startswith(first) and len(first) <= len(c) or first.startswith(c) for c in candidates
        ) or any(first.startswith(c.split()[0]) for c in candidates)

    def _plan_push(self, text: str) -> str:
        """Streaming-safe planning-heading filter: drops internal CoT heading
        lines and deliberation leak lines, buffering only the trailing partial
        line that could still become a heading. Visible answer content is never
        discarded, no matter how many headings appear."""
        if not text:
            return ""
        self._plan_buf += text
        out_parts: list[str] = []
        while "\n" in self._plan_buf:
            idx = self._plan_buf.index("\n")
            line = self._plan_buf[: idx + 1]
            self._plan_buf = self._plan_buf[idx + 1 :]
            bare = line.rstrip("\r\n")
            if _match_planning_heading(bare) is not None:
                continue
            # Drop leaked deliberation lines (e.g. ":** I should...")
            if re.search(r":\*\*|I should respond|I should acknowledge|Acknowledge the friendly", line, re.IGNORECASE):
                continue
            out_parts.append(line)
        # If the remaining buffer could still become a heading, hold it
        if self._plan_buf and self._is_plan_prefix(self._plan_buf):
            return "".join(out_parts)
        if self._plan_buf:
            # Not a heading prefix -> emit it now
            tail = self._plan_buf
            self._plan_buf = ""
            return "".join(out_parts) + tail
        return "".join(out_parts)

    def _plan_flush(self) -> str:
        if not self._plan_buf:
            return ""
        line = self._plan_buf
        self._plan_buf = ""
        # Only treat as single heading if no newline (single incomplete line)
        if "\n" not in line:
            m = _match_planning_heading(line.strip())
            if m:
                name, after = m
                if name not in _ANSWER_HEADING_NAMES:
                    return ""
                if after:
                    return after
                return ""
        return line

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
        raw = "".join(out)
        return self._plan_push(raw)

    def flush(self) -> str:
        if self.state == "thinking":
            self.pending = ""
            tail = self._plan_flush()
            if re.match(r"^\s*\d+\.\s*", tail):
                tail = re.sub(r"^\s*\d+\.\s*", "", tail)
            return _strip_freeform_deliberation(tail).strip()

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
        plan_tail = self._plan_flush()
        combined = out + plan_tail
        stripped = _strip_planning_headings(combined)
        # Only apply enumeration cleanup when the batch strip actually removed
        # something; otherwise a normal numbered answer keeps its numbering.
        if stripped != combined and re.match(r"^\s*\d+\.\s*", stripped):
            stripped = re.sub(r"^\s*\d+\.\s*", "", stripped)
        return _strip_freeform_deliberation(stripped).strip()

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
    # Fast path: thinking/response markers first, then planning headings, then freeform deliberation.
    filter_ = ReasoningFilter()
    primary = (filter_.push(text) + filter_.flush()).strip()
    after_headings = _strip_planning_headings(primary).strip()
    return _strip_freeform_deliberation(after_headings).strip()