/**
 * Workspace intent detection: tells the context engine whether a chat question
 * is about the workspace itself (is it connected? what files does it contain?
 * what is this project?) rather than about specific code. Those questions need
 * status or manifest context instead of keyword retrieval, which can never
 * match "can you see my folder?" or "list my files".
 *
 * The classifier is deliberately narrow so ordinary code questions fall
 * through to the normal retrieval path.
 */
export type WorkspaceIntent = "status" | "manifest" | "summary" | "none";

const STATUS_PATTERNS: RegExp[] = [
  /\b(can you|do you|are you|did you)\b.*\b(see|access|read|view|open|get|receive)\b.*\b(folder|project|workspace|directory|repo)\b/i,
  /\b(see|access|read|open)\b.*\bmy\s+(folder|project|workspace|directory|repo)\b/i,
  /\b(folder|project|workspace|directory|repo)\b.*\b(connected|linked|shared|indexed)\b/i,
  /\b(what do you know|what have you got|do you have)\b.*\b(folder|project|workspace)\b/i,
  /\bis\s+(my\s+)?(folder|project|workspace)\b.*\b(indexed|connected|shared|linked)\b/i
];

const SUMMARY_PATTERNS: RegExp[] = [
  /\bwhat is this project\b/i,
  /\bwhat is this\b.*\b(project|folder|workspace|repo)\b/i,
  /\btell me about\b.*\b(project|workspace|folder|repo)\b/i,
  /\bsummar(?:y|ize)\b.*\b(project|workspace|folder|repo)\b/i,
  /\boverview\b.*\b(project|workspace|folder|repo)\b/i
];

const MANIFEST_PATTERNS: RegExp[] = [
  /\bwhat files\b.*\b(in|on|inside|under|within)\b/i,
  /\blist\b.*\bfiles?\b/i,
  /\bshow( me)?\b.*\b(structure|tree|files|layout)\b/i,
  /\b(project|folder|directory|repo)\s+structure\b/i,
  /\bfile\s+(tree|list)\b/i,
  /\bwhat(?:'s| is) in\b.*\b(folder|project|workspace|directory|repo)\b/i,
  /\b(which|what) files\b.*\b(are there|do you have|do i have|exist)\b/i,
  /\bwhat do you see\b.*\b(?:in|on)\b/i
];

export function classifyWorkspaceIntent(question: string): WorkspaceIntent {
  const q = question.trim();
  if (!q) return "none";
  if (SUMMARY_PATTERNS.some((re) => re.test(q))) return "summary";
  // Manifest questions are checked before status: "what do you see in my repo?"
  // is about contents, not about whether the connection works.
  if (MANIFEST_PATTERNS.some((re) => re.test(q))) return "manifest";
  if (STATUS_PATTERNS.some((re) => re.test(q))) return "status";
  return "none";
}