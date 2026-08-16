"use client";

import { useState } from "react";
import { useWorkspaceStore } from "@/workspace/store";
import {
  FolderIcon,
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
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const index = useWorkspaceStore((s) => s.index);
  const searchResults = useWorkspaceStore((s) => s.searchResults);
  const searching = useWorkspaceStore((s) => s.searching);
  const connectLocal = useWorkspaceStore((s) => s.connectLocal);
  const connectDemo = useWorkspaceStore((s) => s.connectDemo);
  const disconnect = useWorkspaceStore((s) => s.disconnect);
  const search = useWorkspaceStore((s) => s.search);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const [query, setQuery] = useState("");

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
          {/* Header row */}
          <div className="flex w-full items-center justify-between gap-2 px-4 py-3">
            <span className="flex min-w-0 items-center gap-2 text-xs font-mono font-semibold text-foreground">
              <FolderIcon className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">Path</span>
              {connected && workspace && (
                <span className="truncate text-[10px] font-normal text-muted-foreground">
                  • {workspace.name}
                </span>
              )}
              {connecting && (
                <span className="flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  Opening…
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

          {/* Body */}
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
                <p className="text-[10px] font-mono text-muted-foreground">
                  {index ? `${index.files.length} files indexed` : "Indexing…"}
                </p>
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
            </div>
          )}

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