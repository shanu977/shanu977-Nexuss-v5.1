// Core types for the Path workspace engine.
//
// A workspace is a folder the user explicitly grants Nexuss access to. Every
// file path is RELATIVE to that workspace root and is validated before any
// operation so nothing can ever escape the boundary.

export type WorkspaceKind = "fs-access" | "in-memory" | "native";

export interface Workspace {
  name: string;
  root: string;
  kind: WorkspaceKind;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mtime: number;
  content?: string;
}

export interface IndexedFile {
  path: string;
  name: string;
  ext: string;
  language: string;
  dir: string;
  size: number;
  mtime: number;
  contentHash: string;
  symbols: string[];
  imports: string[];
  chunks: string[];
}

export interface WorkspaceIndex {
  root: string;
  files: IndexedFile[];
  byPath: Map<string, IndexedFile>;
  builtAt: number;
  scannedCount: number;
  changedCount: number;
}

export interface SearchHit {
  file: IndexedFile;
  score: number;
  reasons: string[];
}

export interface WorkspaceSearchOptions {
  explicitFiles?: string[];
  explicitSymbols?: string[];
  errorText?: string;
  limit?: number;
}

export interface ContextBudget {
  maxTokens: number;
  maxFiles: number;
}

export interface ContextResult {
  contextText: string;
  includedFiles: string[];
  estimatedTokens: number;
  truncated: boolean;
}

export type FileOperation =
  | { type: "create"; path: string; content: string }
  | { type: "write"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "rename"; from: string; to: string };

export interface OperationResult {
  ok: boolean;
  error?: string;
}

/** High-level lifecycle state of the Path workspace, surfaced in the panel. */
export type WorkspaceStatus =
  | "idle"
  | "selecting" // folder picker is open
  | "reading" // walking the folder and reading supported files
  | "indexing" // building the search index
  | "connected" // discovery + indexing completed
  | "error"; // discovery or indexing failed

/** Classified connect failure so the UI can show a useful, safe message. */
export type WorkspaceErrorKind =
  | "unsupported-browser"
  | "permission"
  | "unknown";