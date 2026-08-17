// Context budget + token minimization for the workspace engine.
//
// Retrieval is exact-match (see search.ts) and the assembled context is capped
// by a configurable token budget, so the model never receives the whole
// project — only the most relevant files/sections for the current question.

import { findMentionedFiles, searchIndex, tokenize } from "./search";
import type { WorkspaceManifest } from "./manifest";
import type {
  ContextBudget,
  ContextResult,
  IndexedFile,
  Workspace,
  WorkspaceIndex
} from "./types";

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { maxTokens: 6000, maxFiles: 20 };

export const WORKSPACE_CONTEXT_HEADER =
  "Relevant files from the user's local workspace (selected by the workspace engine):";

export const WORKSPACE_STATUS_HEADER =
  "Workspace status from the user's connected Path workspace:";

export const WORKSPACE_MANIFEST_HEADER =
  "Files in the user's workspace (workspace manifest):";

export const WORKSPACE_REFERENCE_HEADER =
  "Referenced file from the user's connected workspace:";

export const WORKSPACE_AMBIGUITY_HEADER =
  "Workspace reference needs clarification:";

export const WORKSPACE_DISCONNECTED_HEADER =
  "Workspace status (no folder connected):";

/** Rough CJK-aware token estimate, consistent with the backend estimate. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

function chunkScore(chunk: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = chunk.toLowerCase();
  return tokens.reduce((sum, t) => (lower.includes(t) ? sum + 1 : sum), 0);
}

/** For a file too big to fit whole, return only its most relevant chunks. */
export function pickRelevantChunks(
  file: IndexedFile,
  tokens: string[],
  maxTokens: number
): string {
  const scored = file.chunks
    .map((chunk, i) => ({ chunk, i, score: chunkScore(chunk, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const parts: string[] = [];
  let used = 0;
  for (const { chunk } of scored) {
    const cost = estimateTokens(chunk);
    if (used + cost > maxTokens) continue;
    parts.push(chunk);
    used += cost;
  }
  return parts.join("\n");
}

/**
 * Select the most relevant workspace context for a question and assemble it
 * within the configured token budget. Mentioned files and high-scoring hits are
 * preferred; files that exceed the remaining budget contribute only their best
 * matching chunks.
 */
export function buildContextText(
  index: WorkspaceIndex,
  query: string,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): ContextResult {
  const mentioned = findMentionedFiles(index, query).map((f) => f.path);
  const hits = searchIndex(index, query, {
    explicitFiles: mentioned,
    limit: budget.maxFiles * 2
  });

  const byPath = new Map<string, IndexedFile>();
  for (const path of mentioned) {
    const file = index.byPath.get(path);
    if (file) byPath.set(path, file);
  }
  for (const h of hits) {
    if (!byPath.has(h.file.path)) byPath.set(h.file.path, h.file);
  }

  const tokens = tokenize(query);
  const sections: string[] = [];
  const includedFiles: string[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const file of byPath.values()) {
    if (includedFiles.length >= budget.maxFiles) {
      truncated = true;
      break;
    }
    const full = file.chunks.join("\n");
    if (!full) continue;
    const fullTokens = estimateTokens(full);
    if (usedTokens + fullTokens <= budget.maxTokens) {
      sections.push(`### ${file.path}\n${full}`);
      includedFiles.push(file.path);
      usedTokens += fullTokens;
    } else {
      const remaining = budget.maxTokens - usedTokens;
      if (remaining > 0) {
        const partial = pickRelevantChunks(file, tokens, remaining);
        if (partial) {
          sections.push(`### ${file.path}\n${partial}`);
          includedFiles.push(file.path);
          usedTokens += estimateTokens(partial);
        }
      }
      truncated = true;
      break;
    }
  }

  const contextText = sections.length
    ? `${WORKSPACE_CONTEXT_HEADER}\n\n${sections.join("\n\n")}`
    : "";

  return {
    contextText,
    includedFiles,
    estimatedTokens: usedTokens,
    truncated
  };
}

/**
 * Tiny context for workspace-status questions ("can you see my folder?").
 * Tells the model the workspace is connected and what was indexed, without
 * sending any file contents.
 */
export function buildStatusContext(
  workspace: Workspace,
  index: WorkspaceIndex | null
): ContextResult {
  const count = index ? index.files.length : 0;
  const noun = count === 1 ? "file is" : "files are";
  const text = index
    ? `${WORKSPACE_STATUS_HEADER}\n\n` +
      `The user's workspace "${workspace.name}" is connected and ${count} ${noun} indexed. ` +
      `Answer based on this state.`
    : `${WORKSPACE_STATUS_HEADER}\n\n` +
      `The user's workspace "${workspace.name}" is connected but no files could be indexed.`;
  return {
    contextText: text,
    includedFiles: [],
    estimatedTokens: estimateTokens(text),
    truncated: false
  };
}

/**
 * Manifest context for questions that ask about the workspace contents
 * ("list my files", "what is this project?"). Sends directory + file names
 * only — never file contents — and is capped to the token budget by halving
 * the listed files until it fits.
 */
export function buildManifestContext(
  workspace: Workspace,
  manifest: WorkspaceManifest,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): ContextResult {
  const header =
    `${WORKSPACE_MANIFEST_HEADER}\n\n` +
    `Workspace: ${workspace.name}\nTotal files: ${manifest.files.length}`;
  const dirs = manifest.directories.length
    ? `\n\nDirectories:\n${manifest.directories.map((d) => `- ${d}`).join("\n")}`
    : "\n\nDirectories: (none)";
  const prefix = `${header}${dirs}\n\nFiles:`;

  const total = manifest.files.length;
  let count = total;
  let truncated = false;
  let text = `${prefix}\n${manifest.files.join("\n")}`;
  while (estimateTokens(text) > budget.maxTokens && count > 0) {
    truncated = true;
    count = Math.floor(count / 2);
    text = `${prefix}\n${manifest.files
      .slice(0, count)
      .join("\n")}${total > count ? `\n… (${total - count} more files not listed)` : ""}`;
  }
  // Pathological case: the directory listing alone exceeds the budget (e.g. a
  // huge tree with a tiny budget). Drop it so the file list still fits.
  if (estimateTokens(text) > budget.maxTokens) {
    truncated = true;
    text = `${header}\n\nFiles:\n${manifest.files
      .slice(0, count)
      .join("\n")}${total > count ? `\n… (${total - count} more files not listed)` : ""}`;
  }

  return {
    contextText: text,
    includedFiles: manifest.files.slice(0, Math.min(count, budget.maxFiles)),
    estimatedTokens: estimateTokens(text),
    truncated
  };
}

/**
 * Context for a single explicitly-referenced workspace file (ordinal, filename,
 * "it"/"this"): the file whole when it fits the budget, otherwise only its most
 * relevant chunks. Never the whole workspace.
 */
export function buildFileContext(
  index: WorkspaceIndex,
  path: string,
  question: string,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): ContextResult | null {
  const file = index.byPath.get(path);
  if (!file) return null;
  const full = file.chunks.join("\n");
  if (!full) return null;
  if (estimateTokens(full) <= budget.maxTokens) {
    const text = `${WORKSPACE_REFERENCE_HEADER}\n\n### ${file.path}\n${full}`;
    return {
      contextText: text,
      includedFiles: [path],
      estimatedTokens: estimateTokens(text),
      truncated: false
    };
  }
  const partial = pickRelevantChunks(file, tokenize(question), budget.maxTokens);
  if (!partial) {
    // Nothing fit (e.g. the whole file is a single giant chunk): surface a
    // leading slice of the file so the referenced file is still shown, within
    // the token budget.
    const head = full.slice(0, Math.max(1, budget.maxTokens * 4 - 80));
    const text = `${WORKSPACE_REFERENCE_HEADER}\n\n### ${file.path}\n${head}`;
    return {
      contextText: text,
      includedFiles: [path],
      estimatedTokens: estimateTokens(text),
      truncated: true
    };
  }
  const text = `${WORKSPACE_REFERENCE_HEADER}\n\n### ${file.path}\n${partial}`;
  return {
    contextText: text,
    includedFiles: [path],
    estimatedTokens: estimateTokens(text),
    truncated: true
  };
}

/**
 * Context for an unresolvable reference: instructs the model to ask a short
 * clarification question instead of guessing. Candidates are relative paths.
 */
export function buildAmbiguityContext(
  workspace: Workspace,
  candidates: string[]
): ContextResult {
  const list = candidates.map((c) => `- ${c}`).join("\n");
  const text =
    `${WORKSPACE_AMBIGUITY_HEADER}\n\n` +
    `The user referred to a file in their connected workspace "${workspace.name}" but the ` +
    `reference is ambiguous. Do not pick one yourself — ask a short clarification question ` +
    `listing which file they mean.\n\nCandidate files:\n${list}`;
  return {
    contextText: text,
    includedFiles: candidates,
    estimatedTokens: estimateTokens(text),
    truncated: false
  };
}

/**
 * Context for workspace questions asked while NO folder is connected: the model
 * must report the disconnected state and never claim access to any files.
 */
export function buildDisconnectedContext(): ContextResult {
  const text =
    `${WORKSPACE_DISCONNECTED_HEADER}\n\n` +
    `The user does not currently have a project folder connected to Path. If they are asking ` +
    `about files or their project, tell them no folder is connected and to connect one in Path ` +
    `first. Never claim to have access to any files.`;
  return {
    contextText: text,
    includedFiles: [],
    estimatedTokens: estimateTokens(text),
    truncated: false
  };
}