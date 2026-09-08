"use client";

import { useState } from "react";
import { useWorkspaceStore } from "@/workspace/store";
import {
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
  XCircleIcon
} from "@/components/icons";

/**
 * Compact premium details section for the Path workspace. Collapsed to a single
 * header row it only shows the connected workspace name; expanded it shows the
 * connect controls (real folder via the browser picker, or an in-memory sample
 * when the browser cannot access local folders) and, once connected, the file
 * count, live hybrid search, and disconnect. Never a full-screen modal.
 */
export default function WorkspacePanel() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const connected = useWorkspaceStore((s) => s.connected);
  const connecting = useWorkspaceStore((s) => s.connecting);
  const status = useWorkspaceStore((s) => s.status);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const index = useWorkspaceStore((s) => s.index);
  // Diagnostic: log Zustand selector values on every render to verify single store instance
  if (typeof window !== "undefined") {
    console.debug("[Path Panel] render selectors", { connected, hasWorkspace: !!workspace, workspaceName: workspace?.name, status, hasIndex: !!index, timestamp: Date.now() });
  }
  const searchResults = useWorkspaceStore((s) => s.searchResults);
  const searching = useWorkspaceStore((s) => s.searching);
  const connectLocal = useWorkspaceStore((s) => s.connectLocal);
  const connectDemo = useWorkspaceStore((s) => s.connectDemo);
  const disconnect = useWorkspaceStore((s) => s.disconnect);
  const search = useWorkspaceStore((s) => s.search);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const pendingChanges = useWorkspaceStore((s) => s.pendingChanges);
  const agentLog = useWorkspaceStore((s) => s.agentLog);
  const changeError = useWorkspaceStore((s) => s.changeError);
  const approvePendingChanges = useWorkspaceStore((s) => s.approvePendingChanges);
  const rejectPendingChanges = useWorkspaceStore((s) => s.rejectPendingChanges);
  const refreshPendingChanges = useWorkspaceStore((s) => s.refreshPendingChanges);
  const clearChangeError = useWorkspaceStore((s) => s.clearChangeError);
  const pendingCommand = useWorkspaceStore((s) => s.pendingCommand);
  const runningCommand = useWorkspaceStore((s) => s.runningCommand);
  const lastCommandResult = useWorkspaceStore((s) => s.lastCommandResult);
  const commandError = useWorkspaceStore((s) => s.commandError);
  const runPendingCommand = useWorkspaceStore((s) => s.runPendingCommand);
  const cancelPendingCommand = useWorkspaceStore((s) => s.cancelPendingCommand);
  const rejectPendingCommand = useWorkspaceStore((s) => s.rejectPendingCommand);
  const clearCommandError = useWorkspaceStore((s) => s.clearCommandError);
  const clearLastCommandResult = useWorkspaceStore((s) => s.clearLastCommandResult);
  const [query, setQuery] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const panelId = "workspace-details";

  const connectingLabel =
    status === "indexing"
      ? "Indexing files…"
      : status === "reading"
        ? "Reading folder…"
        : "Selecting folder…";

  const handleSearch = (value: string) => {
    setQuery(value);
    search(value);
  };

  return (
    <div className="shrink-0 bg-background px-3 pb-1 sm:px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <section
          aria-label="Workspace"
          className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg animate-fade-in-up"
        >
          {/* Header row: the left side toggles collapse/expand (the compact
              collapsed row shows the connected workspace name); the X fully
              closes the panel. Collapsing only hides the body below — it never
              touches the connection, index, or permissions. */}
          <div className="flex w-full items-center gap-1 px-4 py-3">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              aria-expanded={isExpanded}
              aria-controls={panelId}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-muted/50 cursor-pointer"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs font-mono font-semibold text-foreground">
                <FolderIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">Path</span>
                {connected && workspace && !isExpanded && (
                  <span className="truncate text-[10px] font-normal text-muted-foreground">
                    • {workspace.name}
                  </span>
                )}
                {connecting && (
                  <span className="flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    {connectingLabel}
                  </span>
                )}
              </span>
              <ChevronDownIcon
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  isExpanded ? "rotate-180" : ""
                }`}
              />
            </button>
            <button
              type="button"
              onClick={closePanel}
              aria-label="Close workspace panel"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Body: collapses via CSS only so the connection, index, and query
              stay alive — collapsing hides it (max-h-0 + overflow-hidden), and
              expanding restores it instantly, mirroring the screen-share panel. */}
          <div
            id={panelId}
            className={
              isExpanded
                ? "border-t border-border animate-fade-in-up"
                : "max-h-0 overflow-hidden"
            }
          >
          {!connected ? (
            <div className="border-t border-border p-4 animate-fade-in-up">
              <p className="text-[11px] font-mono text-muted-foreground">
                Give Nexuss a local folder to inspect, search, and fix. Everything
                stays inside the folder you choose.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void connectLocal()}
                  disabled={connecting}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  <FolderIcon className="h-3.5 w-3.5" />
                  Connect a folder
                </button>
                <button
                  type="button"
                  onClick={() => void connectDemo()}
                  disabled={connecting}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-[11px] font-mono font-medium text-foreground transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  Try sample workspace
                </button>
              </div>
              <p className="mt-3 text-[10px] font-mono text-muted-foreground">
                Works in Chrome/Edge. Other browsers can try the sample workspace.
              </p>
            </div>
          ) : (
            <div className="border-t border-border p-4 animate-fade-in-up">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-mono text-muted-foreground">
                    {index ? `${index.files.length} files indexed` : "Indexing…"}
                  </p>
                  {index && index.files.length === 0 && (
                    <p className="mt-0.5 text-[10px] font-mono text-muted-foreground/80">
                      No supported files found in this folder.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[10px] font-mono font-medium text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
                >
                  <XCircleIcon className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2">
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder="Search files, symbols, error text…"
                  aria-label="Search workspace"
                  className="w-full bg-transparent text-xs text-foreground placeholder-muted-foreground outline-none"
                />
              </div>

              {searching ? (
                <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                  Searching…
                </p>
              ) : query.trim() ? (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {searchResults.length === 0 && (
                    <li className="py-1 text-[11px] font-mono text-muted-foreground">
                      No matches.
                    </li>
                  )}
                  {searchResults.slice(0, 8).map((hit) => (
                    <li
                      key={hit.file.path}
                      className="rounded-lg bg-muted/50 px-2.5 py-1.5"
                    >
                      <p className="truncate text-xs font-mono text-foreground">
                        {hit.file.path}
                      </p>
                      <p className="truncate text-[10px] font-mono text-muted-foreground">
                        {hit.reasons.slice(0, 2).join(" • ")}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                  Your questions automatically pull in the most relevant files.
                </p>
              )}

              {/* Workspace Agent: staged changes are reviewed as diffs and only
                  applied after explicit approval. Nothing is written on stage. */}
              {pendingChanges.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <p className="text-[10px] font-mono font-medium text-muted-foreground">
                    Proposed changes — review before applying
                  </p>
                  {changeError && (
                    <div
                      role="alert"
                      className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[10px] font-mono text-destructive"
                    >
                      <span className="flex-1">{changeError.message}</span>
                      <button
                        type="button"
                        onClick={clearChangeError}
                        className="shrink-0 rounded bg-destructive/20 px-2 py-0.5 text-[10px] font-medium hover:bg-destructive/30 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {pendingChanges.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-lg border border-border bg-muted/50 p-2.5"
                      >
                        <div className="flex items-center gap-1.5">
                          {c.kind === "delete" ? (
                            <XCircleIcon className="h-3 w-3 shrink-0 text-destructive" />
                          ) : c.kind === "rename" || c.kind === "move" ? (
                            <ArrowRightLeftIcon className="h-3 w-3 shrink-0 text-primary" />
                          ) : c.kind === "create" ? (
                            <PlusIcon className="h-3 w-3 shrink-0 text-primary" />
                          ) : (
                            <CheckIcon className="h-3 w-3 shrink-0 text-primary" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-foreground">
                            {c.kind} {c.path}
                            {c.toPath ? ` → ${c.toPath}` : ""}
                          </span>
                        </div>
                        <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-background/60 p-2 text-[10px] leading-relaxed text-foreground">
                          {c.diff}
                        </pre>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void approvePendingChanges()}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
                    >
                      <CheckIcon className="h-3.5 w-3.5" />
                      Approve &amp; apply
                    </button>
                    <button
                      type="button"
                      onClick={rejectPendingChanges}
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-[11px] font-mono font-medium text-foreground transition-colors hover:bg-muted/70 cursor-pointer"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshPendingChanges()}
                      className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-mono text-foreground transition-colors hover:bg-muted/70 cursor-pointer"
                    >
                      Reload
                    </button>
                  </div>
                </div>
              ) : agentLog.length > 0 ? (
                <div className="mt-3">
                  <p className="mb-1.5 text-[10px] font-mono font-medium text-muted-foreground">
                    Recent agent activity
                  </p>
                  <ul className="space-y-1">
                    {agentLog
                      .slice(-4)
                      .reverse()
                      .map((entry, i) => (
                        <li
                          key={i}
                          className="truncate text-[10px] font-mono text-muted-foreground"
                        >
                          {entry.message}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}

              {/* Run / test commands staged by the agent are executed only
                  after the user runs them here, through the native runtime's
                  validation layer. The browser never executes anything. */}
              {pendingCommand || runningCommand || lastCommandResult || commandError ? (
                <div className="mt-3 rounded-lg border border-border bg-muted/40 p-2.5">
                  <p className="mb-1.5 text-[10px] font-mono font-medium text-muted-foreground">
                    Command execution
                  </p>
                  {commandError && (
                    <div
                      role="alert"
                      className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[10px] font-mono text-destructive"
                    >
                      <span className="flex-1">{commandError}</span>
                      <button
                        type="button"
                        onClick={clearCommandError}
                        className="shrink-0 rounded bg-destructive/20 px-2 py-0.5 text-[10px] font-medium hover:bg-destructive/30 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {lastCommandResult && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-mono">
                        <span
                          className={
                            lastCommandResult.success
                              ? "text-primary"
                              : "text-destructive"
                          }
                        >
                          {lastCommandResult.timedOut
                            ? "Timed out"
                            : lastCommandResult.killed
                              ? "Killed"
                              : lastCommandResult.success
                                ? "OK"
                                : `Exit ${lastCommandResult.exitCode ?? "n/a"}`}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {lastCommandResult.command} ({lastCommandResult.durationMs}ms)
                        </span>
                      </div>
                      {lastCommandResult.outputTruncated && (
                        <p className="text-[10px] font-mono text-muted-foreground">
                          Output truncated to output limits.
                        </p>
                      )}
                      {(lastCommandResult.stdout || lastCommandResult.stderr) && (
                        <pre className="max-h-32 overflow-auto rounded-md bg-background/60 p-2 text-[10px] leading-relaxed text-foreground">
                          {lastCommandResult.redacted ? "(secrets redacted)\n" : ""}
                          {lastCommandResult.stdout}
                          {lastCommandResult.stderr
                            ? `\n--- stderr ---\n${lastCommandResult.stderr}`
                            : ""}
                        </pre>
                      )}
                      <button
                        type="button"
                        onClick={clearLastCommandResult}
                        className="rounded border border-border px-2 py-0.5 text-[10px] font-mono text-foreground hover:bg-muted/70 cursor-pointer"
                      >
                        Clear result
                      </button>
                    </div>
                  )}
                  {pendingCommand && (
                    <div className="space-y-1.5">
                      <p className="truncate text-[11px] font-mono text-foreground">
                        {pendingCommand.kind === "test"
                          ? "Run the project's tests"
                          : pendingCommand.command}
                      </p>
                      {pendingCommand.cwd && (
                        <p className="truncate text-[10px] font-mono text-muted-foreground">
                          cwd: {pendingCommand.cwd}
                        </p>
                      )}
                      {pendingCommand.plan && (
                        <p className="truncate text-[10px] font-mono text-muted-foreground">
                          {pendingCommand.plan.command} ({pendingCommand.plan.source})
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <button
                          type="button"
                          disabled={runningCommand}
                          onClick={() => void runPendingCommand()}
                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50 cursor-pointer"
                        >
                          <CheckIcon className="h-3.5 w-3.5" />
                          {runningCommand ? "Running…" : "Run"}
                        </button>
                        {runningCommand ? (
                          <button
                            type="button"
                            onClick={() => void cancelPendingCommand()}
                            className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-[11px] font-mono font-medium text-foreground hover:bg-muted/70 cursor-pointer"
                          >
                            <XIcon className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={rejectPendingCommand}
                            className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-[11px] font-mono font-medium text-foreground hover:bg-muted/70 cursor-pointer"
                          >
                            <XIcon className="h-3.5 w-3.5" />
                            Reject
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 border-t border-border bg-destructive/10 px-4 py-2.5 text-[11px] font-mono text-destructive"
            >
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={clearError}
                className="shrink-0 rounded bg-destructive/20 px-2 py-0.5 text-[10px] font-medium hover:bg-destructive/30 cursor-pointer"
                aria-label="Dismiss error"
              >
                Dismiss
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}