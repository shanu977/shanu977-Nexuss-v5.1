// Conversation-aware workspace reference resolution.
//
// Workspace questions come in two flavors:
//   - explicit: "can you see my folder", "list my files", "where is the login code"
//   - implicit: "what's inside it", "open the first one", "what does this do"
//
// Implicit references are resolved from lightweight conversation metadata kept
// in the workspace store (never raw file contents): the file list from the last
// workspace result the user saw, and the last file the user explicitly picked.
// This keeps resolution deterministic and cheap instead of relying on the LLM
// to re-derive it from raw chat history.

import { findMentionedFiles } from "./search";
import type { WorkspaceIndex } from "./types";

/** Lightweight per-conversation metadata about recently seen workspace files. */
export interface ConversationRefs {
  /** File paths from the last workspace result the user saw, in display order. */
  lastSearchResults: string[];
  /** The last file the user explicitly referenced ("the first one", "test.py"). */
  lastReferencedFile: string | null;
}

export type ResolvedReference =
  | { kind: "none" }
  | { kind: "explicit-file"; path: string }
  | { kind: "ordinal"; position: number }
  | { kind: "last-referenced" }
  | { kind: "workspace-deictic" }
  | { kind: "ambiguous"; candidates: string[] };

const ORDINAL_RE =
  /\b(the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|1st|2nd|3rd|4th|5th)\s+(one|file|result|item|entry|match|hit)\b/i;

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};

// "it", "this", "that" and noun phrases like "this file" / "that code".
const DEICTIC_PRONOUN_RE = /\b(it|this|that|these|those)\b/i;
const DEICTIC_NOUN_RE = /\b(this|that|the)\s+(file|code|script|function|module|component|page|config|class|thing)\b/i;

// "what is inside it" / "list what's in there" refer to the workspace itself.
const INSIDE_MANIFEST_RE =
  /\b(what(?:'s| is| are)?|list|show)\b.*\b(inside|within|in\s+(there|it|this|that))\b/i;

function hasDeictic(question: string): boolean {
  return DEICTIC_PRONOUN_RE.test(question) || DEICTIC_NOUN_RE.test(question);
}

/**
 * Resolve a question's workspace reference against the conversation metadata.
 * Priority (spec §12): explicit file mention > previously referenced file >
 * recent search results > active workspace itself > none.
 */
export function resolveReference(
  question: string,
  refs: ConversationRefs,
  index: WorkspaceIndex | null
): ResolvedReference {
  const q = question.trim();
  if (!q) return { kind: "none" };

  // 1. Explicit file/path mention ("open test.py", "show src/auth/login.ts").
  if (index) {
    const mentioned = findMentionedFiles(index, q);
    if (mentioned.length === 1) {
      return { kind: "explicit-file", path: mentioned[0].path };
    }
    if (mentioned.length > 1) {
      return { kind: "ambiguous", candidates: mentioned.map((f) => f.path) };
    }
  }

  // 2. Ordinal reference ("the first one", "second file") -> last result list.
  const ordinal = q.match(ORDINAL_RE);
  if (ordinal) {
    if (refs.lastSearchResults.length === 0) return { kind: "none" };
    if (ordinal[2].toLowerCase() === "last") {
      return { kind: "ordinal", position: refs.lastSearchResults.length };
    }
    const position = ORDINAL_WORDS[ordinal[2].toLowerCase()];
    if (position && position <= refs.lastSearchResults.length) {
      return { kind: "ordinal", position };
    }
    return { kind: "none" };
  }

  // 3. "what is inside it" -> the active workspace itself (manifest), never a
  //    specific file. Explicit file mentions were already handled above.
  if (INSIDE_MANIFEST_RE.test(q)) {
    return { kind: "workspace-deictic" };
  }

  // 4. Deictic file reference ("it", "this", "that file", "this code").
  if (hasDeictic(q)) {
    if (refs.lastReferencedFile) return { kind: "last-referenced" };
    if (refs.lastSearchResults.length === 1) {
      // The single obvious previous file.
      return { kind: "ordinal", position: 1 };
    }
    if (refs.lastSearchResults.length > 1) {
      return { kind: "ambiguous", candidates: refs.lastSearchResults };
    }
    return { kind: "none" };
  }

  return { kind: "none" };
}