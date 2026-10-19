"use client";

import { useEffect, useState } from "react";
import { useWorkspaceStore } from "@/workspace/store";
import { useTerminalConnectionStore } from "@/workspace/terminalConnection";
import { markTerminalSetupVerified } from "@/workspace/terminalSetup";
import TerminalConnectionScreen from "@/components/TerminalConnectionScreen";
import {
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  TerminalIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
  XCircleIcon
} from "@/components/icons";

/**
 * Terminal / Agent workspace panel. The body is driven by the verified
 * terminal connection state (single source of truth): while the local
 * connector is not verified it shows the simple connection screen (one
 * "Connect Terminal" action, no manual port/URL configuration), and once
 * connected it shows the terminal connection status plus the workspace file
 * search, staged changes and command execution surfaces. All execution still
 * flows through the existing authorized terminal runtime — this component only
 * presents the connection and its results.
 */
export default function WorkspacePanel() {
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const index = useWorkspaceStore((s) => s.index);
  const searchResults = useWorkspaceStore((s) => s.searchResults);
  const searching = useWorkspaceStore((s) => s.searching);
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
  const terminalStatus = useTerminalConnectionStore((s) => s.status);
  const justConnected = useTerminalConnectionStore((s) => s.justConnected);
  const checkConnection = useTerminalConnectionStore((s) => s.checkConnection);
  const connectTerminal = useTerminalConnectionStore((s) => s.connect);
  const disconnectTerminal = useTerminalConnectionStore((s) => s.disconnect);
  const [query, setQuery] = useState("");
  // Opening the Terminal must show the connection screen immediately; the
  // connected panel keeps the existing compact-by-default behaviour.
  const [isExpanded, setIsExpanded] = useState(terminalStatus !== "connected");
  const panelId = "workspace-details";

  // Opening the panel verifies whether the local connector is already
  // reachable — no manual configuration, no fake "ready" state.
  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  // A verified connection means the one-time setup (if any) is done: later
  // failures show the simple recovery screen instead of the setup offer.
  useEffect(() => {
    if (terminalStatus === "connected") markTerminalSetupVerified();
  }, [terminalStatus]);

  const handleSearch = (value: string) => {
    setQuery(value);
    search(value);
  };

  return (
    <div className="shrink-0 bg-background px-3 pb-1 sm:px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <section
          aria-label="Terminal workspace"
          className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg animate-fade-in-up"
        >
          {/* Header row: the left side toggles collapse/expand; the X fully
              closes the panel. Collapsing only hides the body below — it never
              touches the connection or staged work. The small status dot shows
              the verified terminal connection state. */}
          <div className="flex w-full items-center gap-1 px-4 py-3">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              aria-expanded={isExpanded}
              aria-controls={panelId}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-muted/50 cursor-pointer"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs font-mono font-semibold text-foreground">
                <TerminalIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">Terminal</span>
              </span>
              <ChevronDownIcon
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  isExpanded ? "rotate-180" : ""
                }`}
              />
            </button>
            <span
              role="status"
              aria-label={
                terminalStatus === "connected"
                  ? "Terminal connected"
                  : terminalStatus === "connecting"
                    ? "Connecting to terminal"
                    : terminalStatus === "recovering"
                      ? "Recovering terminal connection"
                      : terminalStatus === "setting_up"
                        ? "Setting up terminal"
                        : terminalStatus === "permission_required"
                          ? "Local network permission required"
                          : terminalStatus === "unavailable"
                            ? "Local connector not running"
                            : terminalStatus === "error"
                              ? "Terminal connection failed"
                              : "Terminal disconnected"
              }
              className="flex shrink-0 items-center gap-1.5 pr-1"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  terminalStatus === "connected"
                    ? "bg-emerald-500"
                    : terminalStatus === "connecting" ||
                        terminalStatus === "recovering" ||
                        terminalStatus === "setting_up"
                      ? "animate-pulse bg-primary"
                      : terminalStatus === "permission_required"
                        ? "bg-amber-500"
                        : terminalStatus === "unavailable" || terminalStatus === "error"
                          ? "bg-destructive"
                          : "bg-muted-foreground/50"
                }`}
              />
              {terminalStatus === "connecting" && (
                <span className="text-[10px] font-mono font-normal text-muted-foreground">
                  Connecting…
                </span>
              )}
              {terminalStatus === "recovering" && (
                <span className="text-[10px] font-mono font-normal text-muted-foreground">
                  Recovering…
                </span>
              )}
              {terminalStatus === "setting_up" && (
                <span className="text-[10px] font-mono font-normal text-muted-foreground">
                  Setting up…
                </span>
              )}
            </span>
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
          {terminalStatus !== "connected" ? (
            <TerminalConnectionScreen
              status={terminalStatus}
              onConnect={() => void connectTerminal()}
            />
          ) : (
            <div className="border-t border-border p-4 animate-fade-in-up">
              {/* Verified connection status — only ever shown after the local
                  connector health + execution capability checks succeeded. */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[11px] font-mono font-medium text-foreground">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    Terminal Connected
                  </p>
                  <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
                    {justConnected
                      ? "Nexuss can now execute authorized terminal tasks on this device."
                      : "Nexuss can use the authorized terminal on this device."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void disconnectTerminal()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[10px] font-mono font-medium text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
                >
                  <XCircleIcon className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </div>

              {index && (
                <p className="mt-3 text-[10px] font-mono text-muted-foreground">
                  {index.files.length} files indexed
                  {index.files.length === 0 && (
                    <span className="text-muted-foreground/80">
                      {" "}
                      — no supported files found in this folder.
                    </span>
                  )}
                </p>
              )}

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