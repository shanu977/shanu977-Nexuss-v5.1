"use client";

import type { UseScreenShare } from "@/hooks/useScreenShare";
import {
  MonitorIcon,
  ChevronDownIcon,
  XCircleIcon,
  ArrowRightLeftIcon
} from "@/components/icons";

interface ScreenSharePanelProps {
  screenShare: UseScreenShare;
}

/**
 * Compact premium details section for the live screen share. Collapsed it is a
 * single header row inside the chatboard; expanded it shows the live preview,
 * the active source (only the currently selected one is ever shown — the
 * browser never exposes the full source list to the page), and the
 * change/stop controls. Never a full-screen modal.
 */
export default function ScreenSharePanel({ screenShare }: ScreenSharePanelProps) {
  const {
    isActive,
    isStarting,
    error,
    clearError,
    selectedSourceName,
    isExpanded,
    setExpanded,
    videoRef,
    changeScreen,
    stopSharing
  } = screenShare;

  const panelId = "screen-share-details";

  return (
    <div className="shrink-0 bg-background px-3 pb-1 sm:px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <section
          aria-label="Screen share"
          className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg animate-fade-in-up"
        >
          <button
            type="button"
            onClick={() => setExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-controls={panelId}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 cursor-pointer"
          >
            <span className="flex min-w-0 items-center gap-2 text-xs font-mono font-semibold text-foreground">
              <MonitorIcon className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">Screen Share</span>
              {isActive && selectedSourceName && !isExpanded && (
                <span className="hidden truncate text-[10px] font-normal text-muted-foreground sm:inline">
                  • {selectedSourceName}
                </span>
              )}
            </span>
            <ChevronDownIcon
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          </button>

          {isExpanded && (
            <div id={panelId} className="border-t border-border p-4">
              {/* Live preview fed by the MediaStream */}
              <div className="overflow-hidden rounded-xl border border-border bg-black">
                <video
                  ref={videoRef}
                  muted
                  autoPlay
                  playsInline
                  aria-label="Live screen share preview"
                  className="aspect-video w-full object-contain"
                />
                {isStarting && (
                  <div className="flex items-center justify-center gap-2 bg-card py-3 text-[11px] font-mono text-muted-foreground">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    Waiting for selection…
                  </div>
                )}
              </div>

              {/* Active source (only the selected one is ever shown: the
                  browser does not expose the full list to the page) */}
              <p className="mb-2 mt-4 text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
                Sharing
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                  aria-hidden="true"
                />
                <span className="truncate text-xs text-foreground">
                  {selectedSourceName || (isStarting ? "Selecting…" : "Live screen")}
                </span>
              </div>

              {/* Controls */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void changeScreen()}
                  disabled={isStarting}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-[11px] font-mono font-medium text-foreground transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  <ArrowRightLeftIcon className="h-3.5 w-3.5" />
                  Change screen
                </button>
                <button
                  type="button"
                  onClick={stopSharing}
                  className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] font-mono font-medium text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
                >
                  <XCircleIcon className="h-3.5 w-3.5" />
                  Stop sharing
                </button>
              </div>
            </div>
          )}

          {/* Concise, user-friendly errors (cancelled, denied, unsupported) */}
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
