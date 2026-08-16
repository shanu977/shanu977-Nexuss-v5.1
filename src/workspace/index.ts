export { useWorkspaceStore } from "./store";
export type {
  ContextBudget,
  ContextResult,
  FileOperation,
  IndexedFile,
  OperationResult,
  SearchHit,
  Workspace,
  WorkspaceFile,
  WorkspaceIndex,
  WorkspaceKind,
  WorkspaceSearchOptions
} from "./types";
export {
  WorkspacePathError,
  assertInsideRoot,
  baseName,
  dirName,
  extName,
  isPathInside,
  joinRelative,
  normalizeRelativePath
} from "./path";
export { isSecretFileName, redactSecrets } from "./security";
export {
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  buildIndex,
  chunkText,
  contentHash,
  extractImports,
  extractSymbols,
  indexFile,
  isIgnoredPath,
  isSupportedFile,
  updateIndex
} from "./indexer";
export { findMentionedFiles, searchIndex, tokenize } from "./search";
export {
  DEFAULT_CONTEXT_BUDGET,
  WORKSPACE_CONTEXT_HEADER,
  buildContextText,
  estimateTokens
} from "./context";
export { FileSystemAccessBridge, InMemoryBridge, detectNativeBridge } from "./bridge";
export type { FileSource, NativeWorkspaceBridge, WorkspaceBridge } from "./bridge";