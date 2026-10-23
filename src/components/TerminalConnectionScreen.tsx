"use client";

import { TerminalIcon } from "@/components/icons";
import type { TerminalConnectionStatus } from "@/workspace/terminalConnection";
import { useTerminalConnectionStore } from "@/workspace/terminalConnection";
import type { RecoveryStep } from "@/workspace/terminalRecovery";
import {
  downloadTerminalSetup,
  hasTerminalSetupVerified,
  isWindowsPlatform
} from "@/workspace/terminalSetup";

/** Short, non-technical progress copy for each recovery step. */
const RECOVERY_STEP_COPY: Record<RecoveryStep, string> = {
  checking: "Diagnosing connection…",
  restarting: "Restarting the terminal service…",
  verifying: "Verifying the connection…"
};

/**
 * The Terminal connection screen shown inside the Terminal panel whenever the
 * local connector is not verified as connected.
 *
 * Normal UX is one click: Connect Terminal probes/activates the local runtime
 * and only then reports Connected. The ONLY technical step that can exist for
 * a website is a consented one-time setup (browsers cannot launch local
 * processes), so first-time failures offer a guided downloadable setup —
 * never raw commands, ports, paths or stack traces. After setup, every
 * connection is one click, and a lost connection is repaired automatically.
 */
export default function TerminalConnectionScreen({
  status,
  onConnect
}: {
  status: TerminalConnectionStatus;
  onConnect: () => void;
}) {
  const recoveryStep = useTerminalConnectionStore((s) => s.recoveryStep);
  const cancelRecovery = useTerminalConnectionStore((s) => s.cancelRecovery);
  const beginSetup = useTerminalConnectionStore((s) => s.beginSetup);
  const failureReason = useTerminalConnectionStore((s) => s.failureReason);
  const lastRestartRequested = useTerminalConnectionStore((s) => s.lastRestartRequested);

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

  if (status === "recovering") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p
          role="status"
          className="flex items-center gap-2 text-[11px] font-mono font-medium text-muted-foreground"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          Recovering connection…
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          {RECOVERY_STEP_COPY[recoveryStep ?? "checking"]}
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          Nexuss will reconnect automatically. Commands stay paused until the connection is verified.
        </p>
        <button
          type="button"
          onClick={() => cancelRecovery()}
          className="mt-3 rounded-lg border border-border px-3 py-2 text-[11px] font-mono font-medium text-muted-foreground transition-colors hover:bg-muted/70 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (status === "setting_up") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p
          role="status"
          className="flex items-center gap-2 text-[11px] font-mono font-medium text-foreground"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          Setting up terminal access
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          Run the setup file you just downloaded (Nexuss-Terminal-Setup.cmd), wait for it
          to finish, then click Retry.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onConnect}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Retry
          </button>
          <button
            type="button"
            onClick={() => downloadTerminalSetup()}
            className="rounded-lg border border-border px-3 py-2 text-[11px] font-mono font-medium text-muted-foreground transition-colors hover:bg-muted/70 cursor-pointer"
          >
            Download setup file again
          </button>
        </div>
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

  // This origin is reachable to the connector but not on its allowlist: a
  // security-policy outcome. No auto-recovery, no bypass — just the honest
  // explanation and a manual retry (a deployment fix could make it work).
  if (status === "error" && failureReason === "origin_blocked") {
    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p className="text-xs font-mono font-semibold text-foreground">
          Terminal access blocked for this site
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          This site isn&apos;t allowed to use the local terminal service on this
          computer. If you didn&apos;t expect this, no changes were made.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] font-mono font-medium text-foreground transition-colors hover:bg-muted/70 cursor-pointer"
        >
          <TerminalIcon className="h-3.5 w-3.5" />
          Try Again
        </button>
      </div>
    );
  }

  // unavailable / error: connector unreachable or verification failed.
  if (status === "unavailable" || status === "error") {
    if (!isWindowsPlatform()) {
      return (
        <div className="border-t border-border p-4 animate-fade-in-up">
          <p className="text-xs font-mono font-semibold text-foreground">
            Terminal access unavailable
          </p>
          <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
            Nexuss terminal access currently supports Windows computers.
          </p>
          <button
            type="button"
            onClick={onConnect}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] font-mono font-medium text-foreground transition-colors hover:bg-muted/70 cursor-pointer"
          >
            Try Again
          </button>
        </div>
      );
    }

    if (!hasTerminalSetupVerified()) {
      // First time on this browser: the connector cannot be started by a
      // website, so offer the guided one-time setup (user-level, consented).
      return (
        <div className="border-t border-border p-4 animate-fade-in-up">
          <p className="text-xs font-mono font-semibold text-foreground">
            Set up terminal access
          </p>
          <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
            To use the terminal, Nexuss needs a small one-time setup on this
            computer (requires Node.js). It runs only for your user account and
            can be removed at any time from your Startup apps.
          </p>
          <button
            type="button"
            onClick={() => {
              beginSetup();
              downloadTerminalSetup();
            }}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Set up terminal access
          </button>
          <p className="mt-2 text-[11px] font-mono text-muted-foreground">
            Ran the setup already?{" "}
            <button
              type="button"
              onClick={onConnect}
              className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 cursor-pointer"
            >
              Retry
            </button>
          </p>
        </div>
      );
    }

    return (
      <div className="border-t border-border p-4 animate-fade-in-up">
        <p className="text-xs font-mono font-semibold text-foreground">
          Terminal connection lost
        </p>
        <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
          We couldn&apos;t reach your terminal service. It may have been closed —
          retry to reconnect.
        </p>
        {lastRestartRequested && (
          <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
            If your computer asks to open{" "}
            <span className="text-foreground">Nexuss Terminal</span>, choose{" "}
            <span className="text-foreground">Allow</span>.
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onConnect}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-mono font-medium text-primary-foreground transition-colors hover:opacity-90 cursor-pointer"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Retry
          </button>
          <button
            type="button"
            onClick={() => downloadTerminalSetup()}
            className="rounded-lg border border-border px-3 py-2 text-[11px] font-mono font-medium text-muted-foreground transition-colors hover:bg-muted/70 cursor-pointer"
          >
            Set up again
          </button>
        </div>
      </div>
    );
  }

  // disconnected (default): the normal one-click connect action.
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
