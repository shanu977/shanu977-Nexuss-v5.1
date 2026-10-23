"use client";

import {
  useLocalConnectionStore,
  isConnectionCardVisible,
  type LocalConnectionPhase,
} from "@/store/localConnectionStore";

// Compact, temporary status card shown in the chat area ONLY while the local
// Ollama connection is being verified or started. It is never persisted as a
// message and disappears the moment the connection is verified (or fails).
// Copy follows the connection lifecycle instead of an arbitrary delay.

const PHASE_COPY: Record<
  Exclude<LocalConnectionPhase, "idle" | "connected">,
  { detail: string; secondary?: string }
> = {
  checking: {
    detail: "Checking your local AI connection...",
  },
  starting: {
    detail: "Starting Ollama and connecting to your local model...",
    secondary: "This usually takes a few seconds.",
  },
  waiting_for_health: {
    detail: "Waiting for local AI to become ready...",
  },
};

export default function LocalConnectionCard() {
  const phase = useLocalConnectionStore((s) => s.phase);

  if (!isConnectionCardVisible(phase)) return null;

  const copy = PHASE_COPY[phase as Exclude<LocalConnectionPhase, "idle" | "connected">];
  if (!copy) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Connecting to local AI"
      className="flex max-w-[90%] items-start gap-3 self-start"
    >
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <img src="/nexuss-logo.png" alt="NEXUSS" className="h-4 w-4 object-contain" />
      </div>
      <div className="flex flex-col gap-1 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-xs font-semibold text-foreground">
          <span
            aria-hidden="true"
            className="h-2 w-2 animate-pulse rounded-full bg-primary"
          />
          Connecting to local AI
        </p>
        <p className="text-xs text-muted-foreground">{copy.detail}</p>
        {copy.secondary && (
          <p className="text-[10px] text-muted-foreground/70">{copy.secondary}</p>
        )}
      </div>
    </div>
  );
}
