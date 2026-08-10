"use client";

import { useEffect, useState } from "react";
import { useUsageStore } from "@/store/usageStore";
import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { getModelLabel } from "@/types/providers";
import { ProviderType } from "@/types";
import { ProviderSummary } from "@/types/usage";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export default function UsageDashboard() {
  const summary = useUsageStore((s) => s.summary);
  const loading = useUsageStore((s) => s.loading);
  const loadSummary = useUsageStore((s) => s.loadSummary);
  const clearUsage = useUsageStore((s) => s.clearUsage);
  const estimateContextTokens = useUsageStore((s) => s.estimateContextTokens);

  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const messages = useChatStore((s) => s.messages);

  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<ProviderType | null>(null);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const contextTokens = estimateContextTokens(
    messages.map((m) => ({ role: m.role, content: m.content }))
  );

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await clearUsage();
    setConfirmClear(false);
  };

  return (
    <div className="space-y-4 font-sans text-xs text-foreground">
      {/* Current Session Context */}
      <section className="rounded-xl border border-border bg-card p-3.5 space-y-2 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          Active Conversation Context
        </h4>
        <div className="flex items-center justify-between rounded-xl bg-background p-2.5 border border-border">
          <div>
            <span className="text-xs font-semibold text-foreground block">Context Tokens</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {messages.length} messages in current thread
            </span>
          </div>
          <span className="rounded-lg bg-muted border border-border px-2.5 py-1 text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400">
            ~{formatTokens(contextTokens)} tok
          </span>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground">
          Active Model: <span className="text-foreground font-medium">{PROVIDER_LABELS[provider]}</span> • {getModelLabel(provider, model)}
        </p>
      </section>

      {/* API Usage Statistics */}
      <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          API Usage Metrics
        </h4>

        {loading ? (
          <p className="text-xs font-mono text-muted-foreground">Loading usage statistics...</p>
        ) : summary.totalRequests === 0 ? (
          <p className="text-xs text-muted-foreground">No usage recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {/* Stat Cards */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-background border border-border p-2.5 text-center shadow-2xs">
                <p className="text-base font-mono font-bold text-foreground">{summary.totalRequests}</p>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Requests</p>
              </div>
              <div className="rounded-xl bg-background border border-border p-2.5 text-center shadow-2xs">
                <p className="text-base font-mono font-bold text-foreground">{formatTokens(summary.totalTokens)}</p>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Tokens</p>
              </div>
            </div>

            {/* Per-Provider Breakdown */}
            <div className="space-y-2">
              {summary.providers.map((ps: ProviderSummary) => (
                <div key={ps.provider} className="rounded-xl border border-border bg-background p-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedProvider(expandedProvider === ps.provider ? null : ps.provider)
                    }
                    className="flex w-full items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <span className="text-xs font-bold text-foreground font-mono">
                        {PROVIDER_LABELS[ps.provider]}
                      </span>
                      <span className="ml-2 text-[10px] font-mono text-muted-foreground">
                        {ps.requests} reqs
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                      <span>{formatTokens(ps.totalTokens)} tok</span>
                      <span>{formatTime(ps.avgResponseTime)}</span>
                      <span className="text-[9px]">{expandedProvider === ps.provider ? "▲" : "▼"}</span>
                    </div>
                  </button>

                  {expandedProvider === ps.provider && (
                    <div className="mt-2 space-y-1.5 border-t border-border pt-2 font-mono text-[11px]">
                      <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                        <span>Input: {formatTokens(ps.inputTokens)}</span>
                        <span>Output: {formatTokens(ps.outputTokens)}</span>
                        <span>Total: {formatTokens(ps.totalTokens)}</span>
                      </div>
                      {Object.entries(ps.models).map(([modelName, ms]) => (
                        <div
                          key={modelName}
                          className="flex items-center justify-between rounded-lg bg-muted border border-border px-2 py-1 text-[10px]"
                        >
                          <span className="text-foreground font-medium truncate max-w-[120px]">{modelName}</span>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span>{ms.requests} req</span>
                            <span>{formatTokens(ms.totalTokens)} tok</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Clear Usage Data */}
      <section className="pt-1">
        <button
          type="button"
          onClick={() => void handleClear()}
          className={`w-full rounded-xl border px-3 py-2 text-xs font-mono transition-colors cursor-pointer ${
            confirmClear
              ? "border-destructive bg-destructive/10 text-destructive font-semibold"
              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {confirmClear ? "Click again to confirm clear" : "Clear Usage Statistics"}
        </button>
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
