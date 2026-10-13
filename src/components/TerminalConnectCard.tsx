"use client";

import { TerminalIcon } from "@/components/icons";
import { useWorkspaceStore } from "@/workspace/store";

/**
 * Inline chat action shown when a task needs terminal access but the terminal
 * is not connected. Opens the Terminal panel (its connection screen), so the
 * user can connect without entering any technical details.
 */
export default function TerminalConnectCard() {
  return (
    <div className="my-1 max-w-sm rounded-xl border border-border bg-card p-3 shadow-sm">
      <p className="flex items-center gap-2 text-xs font-mono font-semibold text-foreground">
        <TerminalIcon className="h-4 w-4 shrink-0 text-primary" />
        Terminal access required
      </p>
      <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
        This task requires access to your computer&apos;s terminal.
      </p>
      <button
        type="button"
        onClick={() => useWorkspaceStore.getState().openPanel()}
        className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
      >
        <TerminalIcon className="h-3.5 w-3.5" />
        Connect Terminal
      </button>
    </div>
  );
}
