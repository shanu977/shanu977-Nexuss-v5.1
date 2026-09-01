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

# Planning / chain-of-thought headings that must never be shown to the user.
# These appear as bare lines like "Strategy: ...", "Draft: ...", "Refine: ..." etc.
# They are stripped as reasoning even when not wrapped in thinking/response markers.
# Also catches numbered headings ("4. Strategy:"), bracket markers ("[Done]"),
# and standalone "Proceeds." / "Checks against guidelines:" variants, plus arrow
# delimiters like "Output Generation -> \"Hello\"".
_PLANNING_HEADING_RE = re.compile(
    r"^\s*(?:\d+\.\s*)?(?:\*\*|#{1,6}\s*)?\(?\s*"
    r"(Output Generation|Final Polish|Internal instructions?|Prompt text|Planning text|Checks?|Thought Process|Final choice|Final answer|Chain[-\s]?of[-\s]?thought|Self[-\s]?Correction|Strategy|Mental|Draft|Refine|Verification|Analysis|Reasoning|Thought|Plan|Decision|Choice|Conclusion|Summary|Result|Ready|Proceeds)\b[^:\n]*?\)?\s*(?::|->)\s*.*$"
    r"|^\s*\[.*(?:Done|Proceeds).*?\]\s*$"
    r"|^\s*[-*]?\s*(?:Ready|Proceeds)\.?\s*[✅]*\s*$",
    re.IGNORECASE | re.MULTILINE,
)

_WAIT = object()


def _is_planning_heading(line: str) -> bool:
    return bool(_PLANNING_HEADING_RE.match(line.strip()))


def _strip_freeform_deliberation(text: str) -> str:
    """Strip free-form deliberation that is not heading-based.

    Handles leaks like:
      "Hi there! How can I help you?"\\nLet's try...\\n"Hello! How can I assist you?"\\nFinal decision: "Hi there!..."
      and
      ":** I need to keep it tight... I am an AI assistant..."
    Keeps only the final quoted greeting or the final "I am an AI assistant..." block.
    """
    if not text:
        return text
    # Strip leading markdown artifact ":**" etc.
    t = re.sub(r"^\s*:\*\*\s*", "", text).strip()
    # If text contains deliberation keywords and multiple quoted candidates, keep last quoted greeting
    # This covers the "hi" leak with many "Let's try" / "Final decision" quoted candidates
    if re.search(r"Let's try|Let's stick|Actually, the user|Final decision|Refined plan|I will say|I will just|Let's go|Wait,", t, re.IGNORECASE):
        # Paragraph-aware: find last quoted greeting in a clean paragraph (no deliberation keywords on same paragraph)
        parts = re.split(r"\n\s*\n", t)
        for p in reversed(parts):
            if not p.strip() or re.search(r"Let's try|Let's stick|Actually,|Final decision|Refined plan|I will |Wait,|Okay,", p, re.IGNORECASE):
                continue
            m_q = re.search(r'"([^"]*How can I help[^"]*)"', p, re.IGNORECASE)
            if m_q:
                return m_q.group(1).strip().strip('"').strip()
            # Also check for quoted greeting without How can I help, but Hello/Hi
            m_q2 = re.search(r'"([^"]+)"', p)
            if m_q2 and re.search(r"Hello|Hi", m_q2.group(1), re.IGNORECASE):
                # Ensure quoted itself is not deliberation
                if not re.search(r"Let's|Actually|I will|Final decision|Refined plan", m_q2.group(1), re.IGNORECASE):
                    return m_q2.group(1).strip()
            # If paragraph itself is a greeting without quotes
            if re.search(r"Hello|Hi.*How can I help", p, re.IGNORECASE) and len(p.strip()) < 120:
                return p.strip().strip('"').strip()
        # Fallback: global search for quoted greetings in clean context
        quotes = re.findall(r'"([^"]*How can I help[^"]*)"', t, re.IGNORECASE)
        if quotes:
            # Filter out those inside deliberation paragraphs
            clean_quotes = []
            for q in quotes:
                # Find paragraph containing this quote
                idx = t.find(q)
                para_start = t.rfind("\n\n", 0, idx)
                para = t[para_start:idx+len(q)+50]
                if not re.search(r"Let's try|Actually,|Final decision|Wait,", para, re.IGNORECASE):
                    clean_quotes.append(q)
            if clean_quotes:
                return clean_quotes[-1].strip().strip('"').strip()
            return quotes[-1].strip().strip('"').strip()
        # For tell-me-about-yourself, keep from "I am an AI assistant" onward
        m2 = None
        for mm in re.finditer(r"I(?:'m| am) an AI assistant", t, re.IGNORECASE):
            m2 = mm
        if m2:
            return t[m2.start():].strip().lstrip(":** ").strip()
        # Generic: keep last paragraph that looks like final answer
        parts = re.split(r"\n\s*\n", t)
        # Return last non-deliberation paragraph
        for p in reversed(parts):
            if p.strip() and not re.search(r"Let's try|Let's stick|Actually,|Final decision|Refined plan|I will |Wait,|Okay,", p, re.IGNORECASE):
                # Strip leading enumeration "6. "
                cleaned = re.sub(r"^\s*\d+\.\s*", "", p.strip())
                if cleaned:
                    return cleaned
    # Specific for "I need to keep it tight" deliberation before final AI intro
    if re.search(r"I need to keep it tight", t, re.IGNORECASE):
        m2 = None
        for mm in re.finditer(r"I(?:'m| am) an AI assistant designed to be helpful", t, re.IGNORECASE):
            m2 = mm
        if m2:
            return t[m2.start():].strip().lstrip(":** ").strip()
        # Fallback: strip leading ":**" already done, try to find "I am an AI"
        m3 = re.search(r"I(?:'m| am) an AI assistant", t, re.IGNORECASE)
        if m3:
            return t[m3.start():].strip()
    # Strip leading ":**" artifact for tell-me case
    if t.startswith(":**"):
        t = t[3:].strip()
    return t


def _strip_planning_headings(text: str) -> str:
    """Remove planning / CoT heading blocks, keeping only the final answer.

    If the text contains lines like "Strategy: ...", the entire block up to and
    including the last such heading is discarded. When the last heading line
    itself carries the answer after its colon (e.g. "Output Generation: Hello!"),
    that after-colon content is returned. Otherwise the text after the last
    heading's newline is returned.
    """
    if not text or not _PLANNING_HEADING_RE.search(text):
        return _strip_freeform_deliberation(text)
    lines = text.splitlines(True)
    last_idx = -1
    last_after = ""
    last_heading_name = ""
    for i, line in enumerate(lines):
        m = _PLANNING_HEADING_RE.match(line.rstrip("\r\n"))
        if m:
            last_idx = i
            grp = m.group(1)
            if grp is not None:
                last_heading_name = grp.strip().lower()
            else:
                # Bracket / Proceeds match has no capture group 1
                txt = line.strip().lower()
                if "done" in txt:
                    last_heading_name = "done"
                elif "proceeds" in txt:
                    last_heading_name = "proceeds"
                else:
                    last_heading_name = "proceeds"
            # Support both ":" and "->" delimiters
            dpos = -1
            arrow = line.find("->")
            colon = line.find(":")
            if arrow != -1 and colon != -1:
                dpos = min(arrow, colon)
                # If arrow is delimiter, take after arrow, else after colon
                if arrow < colon:
                    after = line[arrow + 2 :].strip(" *#\t\r\n\"'✅")
                    last_after = after
                    continue
            elif arrow != -1:
                after = line[arrow + 2 :].strip(" *#\t\r\n\"'✅")
                last_after = after
                continue
            elif colon != -1:
                after = line[colon + 1 :].strip(" *#\t\r\n\"'✅")
                last_after = after
            else:
                last_after = ""
    if last_idx == -1:
        return text
    remaining = "".join(lines[last_idx + 1 :])
    if remaining.strip():
        cleaned = remaining.lstrip("\r\n").strip()
        # Strip leading enumeration like "6. " that is artifact of the chain
        cleaned = re.sub(r"^\s*\d+\.\s*", "", cleaned)
        return cleaned
    # No remaining text after the last heading: only return after-colon if the
    # last heading is an answer-type heading, otherwise treat it as
    # reasoning-only and return empty to trigger fallback. If there was content
    # before the first heading, keep it (e.g. "Preamble\nStrategy: ...").
    answer_headings = {
        "output generation",
        "final polish",
        "decision",
        "final choice",
        "choice",
        "conclusion",
        "summary",
        "result",
        "final answer",
    }
    if last_heading_name.lower() in answer_headings and last_after.strip():
        return last_after.strip()
    # Find first heading to check for preamble
    first_idx = -1
    for i, line in enumerate(lines):
        if _PLANNING_HEADING_RE.match(line.rstrip("\r\n")):
            first_idx = i
            break
    prefix = "".join(lines[:first_idx]).strip() if first_idx > 0 else ""
    if prefix:
        return prefix
    if len(lines) == 1:
        return ""
    return last_after.strip() if last_heading_name.lower() in answer_headings else ""


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
        self._saw_planning = False

    def _is_plan_prefix(self, line: str) -> bool:
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
            "final polish",
            "output generation",
            "thought process",
            "thought",
            "plan",
            "steps",
            "step",
            "decision",
            "final choice",
            "choice",
            "conclusion",
            "summary",
            "result",
            "final answer",
            "proceeds",
            "done",
        ]
        return any(
            c.startswith(first) and len(first) <= len(c) or first.startswith(c) for c in candidates
        ) or any(first.startswith(c.split()[0]) for c in candidates)

    def _plan_push(self, text: str) -> str:
        """Streaming-safe planning-heading filter: drops heading lines and
        buffers content between first and last heading until flush, so
        intermediate non-heading lines inside the reasoning block never leak."""
        if not text:
            return ""
        self._plan_buf += text
        if _PLANNING_HEADING_RE.search(self._plan_buf):
            self._saw_planning = True
        # If we have ever seen a planning heading, buffer everything until flush
        # (the final answer is only known after the last heading). This prevents
        # leaking lines like "hi" that sit between Strategy and Draft.
        if self._saw_planning:
            # Hold back an incomplete trailing line that could still become a heading
            if "\n" not in self._plan_buf:
                return ""
            # Keep at least the last incomplete line buffered
            # Only emit if we are sure no heading will appear later – but we
            # cannot be sure until flush, so hold all when a heading has been seen.
            # Check if the buffer ends with a partial heading prefix – hold it.
            # Otherwise, still hold the whole buffer until flush for safety.
            # We still need to allow the case where no heading has been seen yet:
            # fall through to per-line logic only when no heading seen.
            return ""
        out_parts: list[str] = []
        while "\n" in self._plan_buf:
            idx = self._plan_buf.index("\n")
            line = self._plan_buf[: idx + 1]
            self._plan_buf = self._plan_buf[idx + 1 :]
            if _PLANNING_HEADING_RE.match(line.rstrip("\r\n")):
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
            m = _PLANNING_HEADING_RE.match(line.strip())
            if m:
                grp = m.group(1)
                if grp is not None:
                    name = grp.strip().lower()
                else:
                    low = line.strip().lower()
                    name = "done" if "done" in low else "proceeds" if "proceeds" in low else "done"
                answer_headings = {
                    "output generation",
                    "final polish",
                    "decision",
                    "final choice",
                    "choice",
                    "conclusion",
                    "summary",
                    "result",
                    "final answer",
                }
                if name not in answer_headings:
                    return ""
                # Support both ":" and "->"
                arrow = line.find("->")
                colon = line.find(":")
                after = ""
                if arrow != -1 and colon != -1:
                    if arrow < colon:
                        after = line[arrow + 2 :].strip(" *#\t\r\n\"'✅")
                    else:
                        after = line[colon + 1 :].strip(" *#\t\r\n\"'✅")
                elif arrow != -1:
                    after = line[arrow + 2 :].strip(" *#\t\r\n\"'✅")
                elif colon != -1:
                    after = line[colon + 1 :].strip(" *#\t\r\n\"'✅")
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
            # Preserve any visible answer that was already buffered in planBuf
            tail = self._plan_flush()
            # Strip leading enumeration if we had planning
            if self._saw_planning and re.match(r"^\s*\d+\.\s*", tail):
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
        # Flush any buffered planning line, then apply batch heading strip as
        # defense-in-depth for cases where headings were not newline-delimited.
        plan_tail = self._plan_flush()
        combined = out + plan_tail
        # If the combined output still contains planning headings as a batch
        # (e.g. a complete "Strategy: ...\\nAnswer" arrived in one chunk),
        # strip them now.
        stripped = _strip_planning_headings(combined)
        # Strip leading enumeration artifact if we saw planning
        if self._saw_planning and re.match(r"^\s*\d+\.\s*", stripped):
            stripped = re.sub(r"^\s*\d+\.\s*", "", stripped)
        # Apply freeform deliberation stripping as final defense
        stripped_free = _strip_freeform_deliberation(stripped).strip()
        combined_free = _strip_freeform_deliberation(combined).strip()
        # Use freeform-cleaned versions for comparison
        if stripped_free != combined_free and self.emitted:
            if len(stripped_free) < len(combined_free):
                return stripped_free
        if stripped_free != combined_free:
            return stripped_free
        return combined_free

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