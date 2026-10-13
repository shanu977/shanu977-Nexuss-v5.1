"use client";

import { TerminalIcon } from "@/components/icons";
import type { TerminalConnectionStatus } from "@/workspace/terminalConnection";

/** The exact command the user runs to start the local connector. */
const CONNECTOR_START_COMMAND = "node local-connector/server.js";

/**
 * The Terminal connection screen shown inside the Terminal panel whenever the
 * local connector is not verified as connected. It never asks the user for
 * ports, URLs or any technical configuration — connecting is a single action
 * handled internally by the connection store. Each non-connected state gets
 * truthful, actionable copy: permission guidance when the browser blocked the
 * local-network request, the startup command when the connector is not
 * running, and a plain retry otherwise.
 */
export default function TerminalConnectionScreen({
  status,
  onConnect
}: {
  status: TerminalConnectionStatus;
  onConnect: () => void;
}) {
  if (status === "connecting") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p
          role="status"
          className="flex items-center gap-2 text-[11px] font-mono font-medium text-muted-foreground"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          Connecting to your terminal...
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          Verifying the local connector before enabling commands.
        </p>
      </div>
    );
  }

  if (status === "permission_required") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p className="text-xs font-mono font-semibold text-foreground">
          Local network permission required
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          Nexuss needs your browser&apos;s permission to reach the terminal on this
          computer. When your browser asks{" "}
          <span className="text-foreground">
            &quot;Allow access to the local network&quot;
          </span>
          , click <span className="text-foreground">Allow</span>, then try again.
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          If you previously blocked it: open Chrome{" "}
          <span className="text-foreground">
            Settings → Privacy and security → Site settings → Local network access
          </span>{" "}
          and allow this site.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
        >
          <TerminalIcon className="h-3.5 w-3.5" />
          Try Again
        </button>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p className="text-xs font-mono font-semibold text-foreground">
          Local connector not running
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          The Nexuss local connector was not found on this computer. Start it by
          running this command in your project folder:
        </p>
        <code className="mt-1.5 block rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-mono text-foreground">
          {CONNECTOR_START_COMMAND}
        </code>
        <button
          type="button"
          onClick={onConnect}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
        >
          <TerminalIcon className="h-3.5 w-3.5" />
          Try Again
        </button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p className="text-xs font-mono font-semibold text-foreground">
          Terminal connection failed
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          Something went wrong while connecting to your terminal. If the
          connector is not running yet, start it with{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px] font-mono text-foreground">
            {CONNECTOR_START_COMMAND}
          </code>{" "}
          and try again.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
        >
          <TerminalIcon className="h-3.5 w-3.5" />
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-border p-4 animate-fade-in-up">
      <p className="text-xs font-mono font-semibold text-foreground">Terminal</p>
      <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
        Connect Nexuss to your computer&apos;s terminal.
      </p>
      <button
        type="button"
        onClick={onConnect}
        className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
      >
        <TerminalIcon className="h-3.5 w-3.5" />
        Connect Terminal
      </button>
    </div>
  );
}
