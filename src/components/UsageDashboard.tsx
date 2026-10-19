"use client";

import { useEffect, useMemo, useState } from "react";
import { useUsageStore } from "@/store/usageStore";
import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { getModelLabel } from "@/types/providers";
import { ProviderType } from "@/types";
import { ProviderSummary } from "@/types/usage";

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

/** Compact token counts: 843, 12.4K, 1.2M */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Response times: 820ms, 2.4s */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                                */
/* ------------------------------------------------------------------ */

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-[92px] flex-col rounded-xl border border-border bg-card p-3 shadow-xs">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-auto pt-1.5 text-[10px] leading-4 text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function MetricSkeleton() {
  return (
    <div
      className="min-h-[92px] animate-pulse rounded-xl border border-border bg-card p-3"
      aria-hidden="true"
    >
      <div className="h-2.5 w-16 rounded bg-muted" />
      <div className="mt-3 h-6 w-20 rounded bg-muted" />
      <div className="mt-3 h-2.5 w-28 rounded bg-muted" />
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${
        open ? "rotate-90" : "rotate-0"
      }`}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Provider breakdown row                                               */
/* ------------------------------------------------------------------ */

function ProviderRow({
  summary,
  open,
  onToggle,
}: {
  summary: ProviderSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const models = Object.entries(summary.models ?? {});
  const providerLabel = PROVIDER_LABELS[summary.provider] ?? summary.provider;

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/60"
      >
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-foreground">
            {providerLabel}
          </span>
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
            {summary.requests.toLocaleString()}{" "}
            {summary.requests === 1 ? "request" : "requests"}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
          <span>{formatTokens(summary.totalTokens)} tok</span>
          <span className="hidden min-[360px]:inline">
            {formatTime(summary.avgResponseTime)}
          </span>
          <ChevronIcon open={open} />
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border bg-muted/40 px-3.5 py-3">
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ["Input", summary.inputTokens],
              ["Output", summary.outputTokens],
              ["Total", summary.totalTokens],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-lg border border-border bg-card px-2.5 py-2"
              >
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                  {formatTokens(Number(value))}
                </p>
              </div>
            ))}
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Model activity
            </p>
            {models.length === 0 ? (
              <p className="mt-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">
                No model-level records available for this provider.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {models.map(([modelName, modelSummary]) => (
                  <li
                    key={modelName}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-2.5 py-2"
                  >
                    <span className="min-w-0 break-all text-[11px] font-medium text-foreground">
                      {modelName}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {modelSummary.requests.toLocaleString()} req
                      <span aria-hidden="true"> · </span>
                      {formatTokens(modelSummary.totalTokens)} tok
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                            */
/* ------------------------------------------------------------------ */

export default function UsageDashboard() {
  const summary = useUsageStore((s) => s.summary);
  const loading = useUsageStore((s) => s.loading);
  const error = useUsageStore((s) => s.error);
  const loadSummary = useUsageStore((s) => s.loadSummary);
  const clearUsage = useUsageStore((s) => s.clearUsage);
  const estimateContextTokens = useUsageStore((s) => s.estimateContextTokens);

  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const messages = useChatStore((s) => s.messages);

  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<ProviderType | null>(
    null
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const contextTokens = useMemo(
    () =>
      estimateContextTokens(
        messages.map((m) => ({ role: m.role, content: m.content }))
      ),
    [messages, estimateContextTokens]
  );

  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  const modelLabel = model ? getModelLabel(provider, model) : "";
  const hasUsage = !loading && summary.totalRequests > 0;

  const handleCancelClear = () => setConfirmClear(false);

  const handleConfirmClear = async () => {
    await clearUsage();
    setConfirmClear(false);
    setExpandedProvider(null);
  };

  return (
    <div className="space-y-4 font-sans text-xs text-foreground">
      {/* Page header */}
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            Usage overview
          </h3>
          <span
            className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            title="Usage is recorded in this browser as you chat."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            On-device
          </span>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">
          Review the active conversation context and your recorded API
          activity in one place.
        </p>
      </header>

      {/* Current conversation context */}
      <section
        aria-labelledby="usage-context-heading"
        className="rounded-xl border border-border bg-card p-3.5 shadow-xs"
      >
        <div className="flex items-center justify-between gap-3">
          <h4
            id="usage-context-heading"
            className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Current conversation
          </h4>
          <span className="shrink-0 rounded-lg border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Estimate
          </span>
        </div>

        <div className="mt-2.5 rounded-xl border border-border bg-background p-3">
          <p className="text-[10px] text-muted-foreground">Active model</p>
          <p className="mt-1 break-words text-xs font-semibold text-foreground">
            {modelLabel || (
              <span className="font-normal italic text-muted-foreground">
                No model selected
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {providerLabel}
          </p>
        </div>

        <dl className="mt-2 grid grid-cols-2 gap-1.5">
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <dt className="text-[10px] text-muted-foreground">Messages</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              {messages.length}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <dt className="text-[10px] text-muted-foreground">
              Est. context tokens
            </dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              ~{formatTokens(contextTokens)}
            </dd>
          </div>
        </dl>

        <p className="mt-2.5 text-[10px] leading-4 text-muted-foreground">
          The context estimate is calculated locally from the characters in
          this thread (roughly 4 characters per token). It is not a
          provider-reported token count.
        </p>
      </section>

      {/* API usage metrics */}
      <section aria-labelledby="usage-api-heading" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h4
            id="usage-api-heading"
            className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            API usage
          </h4>
          {!loading && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {hasUsage
                ? `${summary.totalRequests.toLocaleString()} recorded ${
                    summary.totalRequests === 1 ? "request" : "requests"
                  }`
                : "No recorded activity"}
            </span>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-2" aria-hidden="true">
            <MetricSkeleton />
            <MetricSkeleton />
          </div>
        ) : hasUsage ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <MetricCard
                label="Total requests"
                value={summary.totalRequests.toLocaleString()}
                detail="Recorded in usage history"
              />
              <MetricCard
                label="Total tokens"
                value={formatTokens(summary.totalTokens)}
                detail="Input and output combined"
              />
            </div>

            {/* Provider breakdown */}
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
              <div className="border-b border-border px-3.5 py-3">
                <h5 className="text-xs font-semibold text-foreground">
                  Provider breakdown
                </h5>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Expand a provider to inspect tokens and model activity.
                </p>
              </div>
              <ul>
                {summary.providers.map((ps: ProviderSummary) => (
                  <ProviderRow
                    key={ps.provider}
                    summary={ps}
                    open={expandedProvider === ps.provider}
                    onToggle={() =>
                      setExpandedProvider(
                        expandedProvider === ps.provider ? null : ps.provider
                      )
                    }
                  />
                ))}
              </ul>
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className="rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-5 w-5 text-muted-foreground"
              >
                <path d="M4 19V5" />
                <path d="M4 19h16" />
                <path d="M8 15v-3" />
                <path d="M12 15V8" />
                <path d="M16 15v-5" />
              </svg>
            </div>
            <h5 className="mt-3 text-xs font-semibold text-foreground">
              No usage recorded yet
            </h5>
            <p className="mx-auto mt-1.5 max-w-[280px] text-[11px] leading-5 text-muted-foreground">
              Once requests are recorded, request totals, token counts, and
              per-provider details will appear here. Your current context
              estimate above is shown separately.
            </p>
          </div>
        )}
      </section>

      {/* Clear usage history */}
      <section
        aria-labelledby="usage-clear-heading"
        className="rounded-xl border border-border bg-card p-3.5 shadow-xs"
      >
        <h4
          id="usage-clear-heading"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {confirmClear ? "Click again to confirm clear" : "Clear Usage Statistics"}
        </button>
        {confirmClear && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            This permanently deletes your saved usage statistics for this account.
            Your conversations will not be deleted.
          </p>
        )}
        {confirmClear && (
          <button
            type="button"
            onClick={() => setConfirmClear(false)}
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Cancel
          </button>
        )}
      </section>
    </div>
  );
}
