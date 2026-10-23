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
// `\r` is included so CRLF line endings (rare but possible in provider output)
// are recognized the same as LF: otherwise a "thinking"/"response" marker on a
// `\r\n` line would not match and the internal reasoning would leak.
const BARE_LINE_MARKER_RE = /^[ \t\r]*(thinking|response)[ \t\r]*$/m;

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

// Planning / CoT heading lines that must never be shown. Matches lines like
// "Strategy: ...", "Draft: ...", "Refine: ..." etc (case-insensitive,
// optional markdown wrapping). They are stripped as reasoning.
//
// IMPORTANT: the set is deliberately limited to unambiguous internal
// chain-of-thought labels. Ordinary answer structure ("Summary:", "Result:",
// "Plan:", "Steps:", "Conclusion:", "Decision:") is legitimate user-facing
// content; treating it as reasoning used to truncate and mangle real answers
// (everything before/after such a heading was discarded).
const PLANNING_HEADING_RE =
  /^\s*(?:\d+\.\s*)?(?:\*\*|#{1,6}\s*)?\(?\s*(Final Output Generation|Output Generation|Final Polish|Internal instructions?|Prompt text|Planning text|Follow Constraints?|Constraints|Checks?|Thought Process|Chain[-\s]?of[-\s]?thought|Self[-\s]?Correction|Strategy|Mental|Draft|Refine|Verification|Analysis|Reasoning|Thought)\b[^:\n]*?\)?\s*(?::|->)\s*.*$|^\s*\[.*(?:Done|Proceeds).*?\]\s*$/im;

// Heading names whose after-delimiter text IS the final answer (keep it).
const ANSWER_HEADING_NAMES = new Set([
  "output generation",
  "final output generation",
  "final polish",
]);

interface PlanningHeading {
  name: string;
  after: string;
}

/** Match one line as an internal planning heading, or null. */
function matchPlanningHeading(line: string): PlanningHeading | null {
  const m = line.match(PLANNING_HEADING_RE);
  if (!m) return null;
  let name = (m[1] ?? "").trim().toLowerCase();
  if (!name) {
    const low = line.trim().toLowerCase();
    name = low.includes("done") ? "done" : "proceeds";
  }
  const arrow = line.indexOf("->");
  const colon = line.indexOf(":");
  let after = "";
  if (arrow !== -1 && colon !== -1) {
    after = arrow < colon ? line.slice(arrow + 2) : line.slice(colon + 1);
  } else if (arrow !== -1) {
    after = line.slice(arrow + 2);
  } else if (colon !== -1) {
    after = line.slice(colon + 1);
  }
  return {
    name,
    after: after.replace(/^[ *#\t\r\n"'✅]+/, "").replace(/["'✅\s]+$/, "").trim(),
  };
}

/**
 * Remove internal planning heading LINES from the text, keeping every other
 * line untouched. Only "output generation"-style headings pass their
 * after-delimiter content through; all other internal heading lines are
 * dropped whole. Surrounding answer content is never discarded.
 */
function stripPlanningHeadings(text: string): string {
  if (!text || !PLANNING_HEADING_RE.test(text)) return text;
  const rawLines: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) {
      rawLines.push(text.slice(pos));
      break;
    }
    rawLines.push(text.slice(pos, nl + 1));
    pos = nl + 1;
  }
  let out = "";
  let removed = false;
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\r?\n$/, "");
    const m = matchPlanningHeading(line);
    if (!m) {
      out += rawLine;
      continue;
    }
    removed = true;
    if (ANSWER_HEADING_NAMES.has(m.name) && m.after) {
      out += `${m.after}\n`;
    }
  }
  if (!removed) return text;
  return out.replace(/^\r?\n/, "");
}

// Deliberation markers that indicate the visible reply leaked internal
// back-and-forth ("Let's try...", "Final decision: ...", ...).
const DELIBERATION_RE =
  /Let's try|Let's stick|Actually, the user|Final decision|Refined plan|I will say|I will just|Let's go|Wait,|I should respond|I should acknowledge|should respond with|Follow Constraints|Final Output Generation|Respond only with|Never reveal internal|Be helpful and concise|Acknowledge the friendly|I need to keep it tight/i;
const DELIBERATION_PARAGRAPH_RE =
  /Let's try|Let's stick|Actually,|Final decision|Refined plan|I will |Wait,|Okay,|I should|Follow Constraints|Final Output Generation|Respond only with|Never reveal|Acknowledge the friendly/i;

function stripFreeformDeliberation(text: string): string {
  if (!text) return text;
  let t = text.replace(/^\s*(?:NEXUSS\s*:?\s*)?:\*\*\s*/i, "").trim();
  t = t.replace(/^\s*:\*\*\s*/, "").trim();
  if (!DELIBERATION_RE.test(t)) return t;
  // Deliberation leaked into the visible reply. Keep the last paragraph that
  // is not itself deliberation. The answer is NEVER rewritten into a
  // different fragment (e.g. an extracted greeting): replacing a real answer
  // with a generic greeting destroys context and is worse than a small leak.
  const parts = t.split(/\n\s*\n/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p.trim() || DELIBERATION_PARAGRAPH_RE.test(p)) continue;
    return p.trim().replace(/^\s*\d+\.\s*/, "");
  }
  return "";
}

export class ReasoningFilter {
  private state: ReasoningState = "normal";
  private pending = "";
  private emitted = false;
  private planBuf = "";

  private isPlanPrefix(line: string): boolean {
    if (/:\*\*|I should|Acknowledge the friendly|Follow Constraints|Final Output Generation/i.test(line)) return true;
    let t = line.trim().replace(/^[*#\s\-]+/, "");
    t = t.replace(/^\d+\.\s*/, "").trim();
    t = t.replace(/^[-*]\s*/, "").trim();
    t = t.replace(/^\[|\]$/g, "").trim();
    t = t.toLowerCase();
    if (t === "") return true;
    let first = t.split(":")[0].trim();
    first = first.replace(/\(.*?\)/g, "").trim();
    // Only unambiguous internal CoT labels are held back. Ordinary answer
    // words (summary/result/plan/steps/...) must stream through untouched.
    const candidates = [
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
    ];
    return candidates.some(
      (c) => c.startsWith(first) && first.length <= c.length || first.startsWith(c)
    ) || candidates.some((c) => first.startsWith(c.split(" ")[0]));
  }

  private planPush(text: string): string {
    if (!text) return "";
    this.planBuf += text;
    let out = "";
    while (this.planBuf.includes("\n")) {
      const idx = this.planBuf.indexOf("\n");
      const line = this.planBuf.slice(0, idx + 1);
      this.planBuf = this.planBuf.slice(idx + 1);
      const bare = line.replace(/\r?\n$/, "");
      // Drop internal CoT heading lines and deliberation leak artifacts only.
      if (matchPlanningHeading(bare)) continue;
      if (/:\*\*|I should respond|I should acknowledge|Acknowledge the friendly/i.test(bare)) continue;
      out += line;
    }
    if (this.planBuf && this.isPlanPrefix(this.planBuf)) return out;
    if (this.planBuf) {
      const tail = this.planBuf;
      this.planBuf = "";
      return out + tail;
    }
    return out;
  }

  private planFlush(): string {
    if (!this.planBuf) return "";
    const line = this.planBuf;
    this.planBuf = "";
    if (!line.includes("\n")) {
      const m = matchPlanningHeading(line);
      if (m) {
        if (ANSWER_HEADING_NAMES.has(m.name) && m.after) return m.after;
        return "";
      }
    }
    return line;
  }

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
    return this.planPush(out);
  }

  /** Flush any remaining input (end of stream). Reasoning is never exposed. */
  flush(): string {
    if (this.state === "thinking") {
      this.pending = "";
      const tail = this.planFlush();
      return stripFreeformDeliberation(tail).trim();
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
    const planTail = this.planFlush();
    const combined = out + planTail;
    const stripped = stripPlanningHeadings(combined);
    const cleaned =
      stripped === combined
        ? combined
        : stripped.replace(/^\s*\d+\.\s*/, "");
    return stripFreeformDeliberation(cleaned).trim();
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
  const primary = (filter.push(text) + filter.flush()).trim();
  const afterHeadings = stripPlanningHeadings(primary).trim();
  return stripFreeformDeliberation(afterHeadings).trim();
}