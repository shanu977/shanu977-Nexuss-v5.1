/**
 * Reasoning-tag filter for model responses.
 *
 * The configured models (notably the Qwen3 vision model `qwen/qwen3.6-27b`
 * and other thinking-capable providers) return their internal chain of thought
 * inline in the reply, delimited by reasoning markers:
 *
 *   thinking
 *   <internal reasoning>
 *   response
 *   <final answer>
 *
 * The markers also appear as angle-bracket tags (`<thinking>`, `</thinking>`,
 * `<response>`, `</response>`) and in case/whitespace variants depending on how
 * the provider serves them.
 *
 * `ReasoningFilter` is a stateful, streaming-safe parser: feed it response
 * chunks with `push()` and it emits only the final-answer portion, maintaining
 * state across chunk boundaries (including markers split across chunks). It
 * never removes the actual answer: only recognized reasoning markup and the
 * text inside a reasoning block are discarded. `filterReasoning` is the
 * convenience wrapper for already-complete responses.
 */

export type ReasoningState = "normal" | "thinking";

// Longest possible marker we will hold back while a marker might be arriving
// across chunks (`</thinking>` with extra whitespace). Anything longer cannot
// be a recognized reasoning marker.
const MAX_MARKER = 24;

const ANGLE_MARKER_RE = /<\s*\/?\s*(thinking|think|response)\s*>/i;
const BARE_LINE_MARKER_RE = /^[ \t]*(thinking|response)[ \t]*$/m;

interface Marker {
  index: number;
  end: number;
  type: "open" | "close";
}

function classifyAngleTag(tag: string): "open" | "close" {
  const closing = /^<\s*\//.test(tag);
  const name = tag.replace(/^<\s*\/?\s*/, "").replace(/\s*>$/, "").toLowerCase();
  if ((name === "thinking" || name === "think") && !closing) return "open";
  return "close";
}

function findCompleteMarker(text: string): Marker | null {
  let best: Marker | null = null;

  const angle = text.match(ANGLE_MARKER_RE);
  if (angle && angle.index !== undefined) {
    best = {
      index: angle.index,
      end: angle.index + angle[0].length,
      type: classifyAngleTag(angle[0])
    };
  }

  const bare = text.match(BARE_LINE_MARKER_RE);
  if (bare && bare.index !== undefined) {
    const type: "open" | "close" =
      bare[1].toLowerCase() === "thinking" ? "open" : "close";
    let end = bare.index + bare[0].length;
    if (text[end] === "\n") end += 1;
    const candidate: Marker = { index: bare.index, end, type };
    if (best === null || candidate.index < best.index) best = candidate;
  }

  return best;
}

function isTagPrefix(candidate: string): boolean {
  // `candidate` starts with `<` and has no closing `>` yet; check that the
  // characters so far could still form a recognized reasoning tag.
  const body = candidate.slice(1);
  const m = /^(\s*)(\/?)(\s*)([a-z]*)(\s*)$/i.exec(body);
  if (!m) return false;
  const letters = m[4].toLowerCase();
  return ["thinking", "think", "response"].some(
    (word) => word.startsWith(letters) && letters.length <= word.length
  );
}

function isBareLinePrefix(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (t === "") return true;
  return (
    (t.length <= "thinking".length && "thinking".startsWith(t)) ||
    (t.length <= "response".length && "response".startsWith(t))
  );
}

/**
 * Return the index in `text` from which the text could still become a marker,
 * or null when nothing is pending.
 */
function partialMarkerAt(text: string): number | null {
  let hold: number | null = null;

  const lt = text.lastIndexOf("<");
  if (lt !== -1) {
    const suffix = text.slice(lt);
    if (!suffix.includes(">") && suffix.length <= MAX_MARKER && isTagPrefix(suffix)) {
      hold = lt;
    }
  }

  const nl = text.lastIndexOf("\n");
  const line = text.slice(nl + 1);
  if (line.length <= MAX_MARKER && isBareLinePrefix(line)) {
    const lineHold = nl + 1;
    hold = hold === null ? lineHold : Math.min(hold, lineHold);
  }

  return hold;
}

const TRAILING_WHITESPACE = /[\t \r\n]+$/;
const LEADING_WHITESPACE = /^[\t \r\n]+/;

export class ReasoningFilter {
  private state: ReasoningState = "normal";
  private pending = "";
  private emitted = false;

  /** Feed one response chunk; returns the visible (non-reasoning) portion. */
  push(chunk: string): string {
    this.pending += chunk;
    let out = "";
    let guard = 0;
    while (this.pending.length > 0 && guard++ < 10_000) {
      const result = this.step();
      if (result === "wait") break;
      if (result.length > 0) this.emitted = true;
      out += result;
    }
    return out;
  }

  /** Flush any remaining input (end of stream). Reasoning is never exposed. */
  flush(): string {
    if (this.state === "thinking") {
      this.pending = "";
      return "";
    }

    let out = this.pending;
    this.pending = "";

    // The stream ended mid-marker: drop a trailing incomplete reasoning tag
    // and the line break that preceded it.
    const incomplete = /<\s*\/?\s*(thinking|think|response)\s*$/i.exec(out);
    if (incomplete && incomplete.index !== undefined) {
      out = out.slice(0, incomplete.index);
      out = out.replace(TRAILING_WHITESPACE, "");
    }

    // Drop a trailing bare marker line that was never completed (no newline).
    const nl = out.lastIndexOf("\n");
    const lastLine = out.slice(nl + 1).trim().toLowerCase();
    if (lastLine === "thinking" || lastLine === "response") {
      out = nl >= 0 ? out.slice(0, nl) : "";
    }

    if (out.length > 0) this.emitted = true;
    return out;
  }

  private step(): string | "wait" {
    if (this.pending.length === 0) return "wait";

    if (this.state === "normal") {
      const marker = findCompleteMarker(this.pending);
      if (marker) {
        const markerAtEnd = marker.end === this.pending.length;
        let prefix = this.pending.slice(0, marker.index);
        this.pending = this.pending.slice(marker.end);
        if (marker.type === "open") {
          // Strip the separator before a reasoning block only when it is pure
          // whitespace and nothing has been shown yet (e.g. leading blank lines
          // rendered before the first `thinking` marker).
          if (!this.emitted && prefix.trim() === "") prefix = "";
          // If the stream currently ends right after the open marker, the
          // reasoning never produced content: drop the preceding line break.
          if (markerAtEnd) prefix = prefix.replace(TRAILING_WHITESPACE, "");
          this.state = "thinking";
        } else {
          // A stray reasoning-close boundary: consume the marker and any
          // separator whitespace, but never the answer that follows it.
          this.pending = this.pending.replace(LEADING_WHITESPACE, "");
        }
        return prefix;
      }

      const hold = partialMarkerAt(this.pending);
      if (hold === null) {
        const all = this.pending;
        this.pending = "";
        return all;
      }
      if (hold > 0) {
        let prefix = this.pending.slice(0, hold);
        const ws = TRAILING_WHITESPACE.exec(prefix);
        if (ws && ws.index !== undefined) {
          // Hold back trailing whitespace so a line break preceding an
          // incomplete reasoning tag can still be dropped at flush time.
          prefix = prefix.slice(0, ws.index);
          this.pending = this.pending.slice(ws.index);
        } else {
          this.pending = this.pending.slice(hold);
        }
        if (prefix.length === 0) return "wait";
        return prefix;
      }
      // Everything pending could still become a marker.
      if (this.pending.length > MAX_MARKER) {
        const all = this.pending;
        this.pending = "";
        return all;
      }
      return "wait";
    }

    // THINKING state: discard everything until a close marker completes.
    const close = findCloseMarker(this.pending);
    if (close) {
      this.pending = this.pending.slice(close.end);
      // Skip separator whitespace before the answer.
      this.pending = this.pending.replace(LEADING_WHITESPACE, "");
      this.state = "normal";
      return "";
    }

    const hold = partialMarkerAt(this.pending);
    if (hold === null) {
      this.pending = "";
      return "";
    }
    this.pending = this.pending.slice(hold);
    if (this.pending.length > MAX_MARKER) {
      this.pending = "";
    }
    return "";
  }
}

/** Find the next reasoning CLOSE marker (open markers are ignored while thinking). */
function findCloseMarker(text: string): Marker | null {
  let best: Marker | null = null;

  const angle = text.match(ANGLE_MARKER_RE);
  if (angle && angle.index !== undefined) {
    const type = classifyAngleTag(angle[0]);
    if (type === "close") {
      best = {
        index: angle.index,
        end: angle.index + angle[0].length,
        type
      };
    }
  }

  const bare = text.match(BARE_LINE_MARKER_RE);
  if (bare && bare.index !== undefined) {
    const type: "open" | "close" =
      bare[1].toLowerCase() === "thinking" ? "open" : "close";
    if (type === "close") {
      let end = bare.index + bare[0].length;
      if (text[end] === "\n") end += 1;
      const candidate: Marker = { index: bare.index, end, type };
      if (best === null || candidate.index < best.index) best = candidate;
    }
  }

  return best;
}

/** Strip internal reasoning from a complete model response. */
export function filterReasoning(text: string): string {
  const filter = new ReasoningFilter();
  return filter.push(text) + filter.flush();
}