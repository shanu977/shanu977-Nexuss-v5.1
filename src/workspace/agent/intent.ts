// Authoritative intent resolution: ACTION vs HOW-TO
// Application-controlled, not LLM-controlled. Determines whether execution is allowed.

import { isHowToRequest as plannerIsHowTo, isFilesystemActionRequest } from "./actionPlanner";

export type IntentKind = "action" | "howto" | "none";

export interface ResolvedIntent {
  kind: IntentKind;
  isTerminalExplicit: boolean;
  raw: string;
}

// Follow-up phrases that refer to previous goal
const FOLLOWUP_RE = /\b(do the thing|do it|do that|continue|finish it|put it there|inside it|use that folder|add something to it)\b/i;

export function isFollowUpRequest(text: string): boolean {
  return FOLLOWUP_RE.test(text);
}

export function userExplicitlyWantsTerminal(text: string): boolean {
  return /use (the )?terminal|via terminal|with terminal|check the terminal|through (the )?terminal|using the terminal/i.test(text);
}

export function resolveIntent(text: string): ResolvedIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "none", isTerminalExplicit: false, raw: text };
  // HOW-TO takes precedence: user wants explanation, not execution
  if (plannerIsHowTo(trimmed)) {
    return { kind: "howto", isTerminalExplicit: userExplicitlyWantsTerminal(trimmed), raw: text };
  }
  if (isFilesystemActionRequest(trimmed)) {
    return { kind: "action", isTerminalExplicit: userExplicitlyWantsTerminal(trimmed), raw: text };
  }
  // Generic inspection without filesystem verb but with terminal/inspection semantics
  // e.g., "how many folders are directly inside C:\" or "what version of node"
  if (/\b(how many|tell me|what version|node --version|npm --version|folders on this PC|files on my desktop)\b/i.test(trimmed) && !plannerIsHowTo(trimmed)) {
    return { kind: "action", isTerminalExplicit: userExplicitlyWantsTerminal(trimmed), raw: text };
  }
  // Also treat explicit terminal requests with filesystem verbs as action even if planner misses
  // e.g., "use the terminal and do the thing" should be action (follow-up)
  if (userExplicitlyWantsTerminal(trimmed) && FOLLOWUP_RE.test(trimmed)) {
    return { kind: "action", isTerminalExplicit: true, raw: text };
  }
  // Generic terminal inspection (node --version, list folders etc) -> treat as action if terminal explicit
  if (userExplicitlyWantsTerminal(trimmed)) {
    // If it contains inspection verbs, treat as action
    if (/create|make|list|count|delete|remove|go to|tell me|what'?s inside|how many/i.test(trimmed)) {
      return { kind: "action", isTerminalExplicit: true, raw: text };
    }
  }
  return { kind: "none", isTerminalExplicit: userExplicitlyWantsTerminal(trimmed), raw: text };
}
