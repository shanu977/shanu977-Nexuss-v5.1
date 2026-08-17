export { useWorkspaceStore } from "./store";
export type {
  ContextBudget,
  ContextResult,
  FileOperation,
  IndexedFile,
  OperationResult,
  SearchHit,
  Workspace,
  WorkspaceErrorKind,
  WorkspaceFile,
  WorkspaceIndex,
  WorkspaceKind,
  WorkspaceSearchOptions,
  WorkspaceStatus
} from "./types";
export { buildManifest } from "./manifest";
export type { WorkspaceManifest } from "./manifest";
export { classifyWorkspaceIntent } from "./intent";
export type { WorkspaceIntent } from "./intent";
export { resolveReference } from "./references";
export type { ConversationRefs, ResolvedReference } from "./references";
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
  WORKSPACE_AMBIGUITY_HEADER,
  WORKSPACE_CONTEXT_HEADER,
  WORKSPACE_DISCONNECTED_HEADER,
  WORKSPACE_MANIFEST_HEADER,
  WORKSPACE_REFERENCE_HEADER,
  WORKSPACE_STATUS_HEADER,
  buildAmbiguityContext,
  buildContextText,
  buildDisconnectedContext,
  buildFileContext,
  buildManifestContext,
  buildStatusContext,
  estimateTokens,
  pickRelevantChunks
} from "./context";
export { FileSystemAccessBridge, InMemoryBridge, detectNativeBridge } from "./bridge";
export type { FileSource, NativeWorkspaceBridge, WorkspaceBridge } from "./bridge";
export { ToolError } from "./agent/errors";
export type { ToolErrorCode } from "./agent/errors";
export {
  createUnifiedDiff,
  diffLines,
  splitLines
} from "./agent/diff";
export {
  assertValidPath,
  toolProposeCreate,
  toolProposeDelete,
  toolProposeMove,
  toolProposeUpsert,
  toolProposeWrite,
  toolRead,
  toolRun,
  toolSearch,
  toolTest,
  unwrapError
} from "./agent/tools";
export { extractChangeBlock, stripChangeBlock } from "./agent/parse";
export { newProposalId } from "./agent/types";
export type {
  AgentFileRef,
  AgentLogEntry,
  CommandBridge,
  CommandResult,
  ParsedChangeBlock,
  ParsedChangeOp,
  ProposedChange,
  ProposedChangeKind,
  ReadToolResult,
  ToolContext,
  WorkspaceBridgeLike
} from "./agent/types";