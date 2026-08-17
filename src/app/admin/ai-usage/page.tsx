"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { KPICard } from "@/components/admin/KPICard";
import { ChartCard } from "@/components/admin/ChartCard";
import { DateRangeSelector } from "@/components/admin/DateRangeSelector";
import { FilterDropdown } from "@/components/admin/FilterDropdown";
import { SkeletonLoader, ErrorState } from "@/components/admin/States";
import { adminApi } from "@/services/admin";
import type { AiUsageResponse } from "@/types/admin";
import { formatNumber } from "@/utils/format";

const DAY_MS = 86_400_000;
const CHART_COLORS = ["#22C55E", "#3B82F6", "#A855F7", "#F59E0B", "#06B6D4", "#EF4444", "#6366F1", "#EC4899"];

const RANGE_DAYS: Record<string, number> = {
  "7D": 7,
  "30D": 30,
  "3M": 90,
  "1Y": 365,
};

function rangeToMs(range: string): { from_ms: number; to_ms: number } {
  const days = RANGE_DAYS[range] ?? 7;
  const to = Date.now();
  return { from_ms: to - days * DAY_MS, to_ms: to };
}

function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

export default function AdminAiUsagePage() {
  const [timeRange, setTimeRange] = useState("7D");
  const [providerFilter, setProviderFilter] = useState("All");
  const [knownProviders, setKnownProviders] = useState<string[]>([]);

  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAiData = useCallback(async (range: string, provider: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getAiUsage({
        ...rangeToMs(range),
        provider: provider === "All" ? undefined : provider,
      });
      setData(res);
      setKnownProviders((prev) => Array.from(new Set([...prev, ...res.by_provider.map((p) => p.key)])));
    } catch {
      setError("Unable to load AI analytics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAiData(timeRange, providerFilter);
  }, [timeRange, providerFilter, fetchAiData]);

  if (loading && !data) {
    return <SkeletonLoader height="100px" count={4} />;
  }

  if (error || !data) {
    return <ErrorState message={error || "No analytics data available."} onRetry={() => fetchAiData(timeRange, providerFilter)} />;
  }

  const totals = data.totals;
  const providerDistribution = data.by_provider.map((p, i) => ({
    name: p.key,
    value: p.requests,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
  const timeSeries = data.series.map((d) => ({ date: d.date, requests: d.requests, successful: d.successful, failed: d.failed }));
  const modelSeries = data.by_model.slice(0, 10);
  const errorSeries = data.by_provider.filter((p) => p.failed > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>
            AI Usage & Provider Intelligence
          </h1>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>
            Monitor tokens, requests, and provider performance across your AI providers
          </p>
        </div>
        <DateRangeSelector selected={timeRange} onChange={setTimeRange} />
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px" }}>
        <KPICard title="Total Requests" value={formatNumber(totals.total_requests)} type="ai" subtitle={`${percent(totals.total_requests, totals.total_requests)}% of attempts`} />
        <KPICard title="Successful" value={formatNumber(totals.successful_requests)} type="success" subtitle={`${percent(totals.successful_requests, totals.total_requests)}% success rate`} />
        <KPICard title="Failed" value={formatNumber(totals.failed_requests)} type="errors" subtitle={`${percent(totals.failed_requests, totals.total_requests)}% failure rate`} />
        <KPICard title="Total Tokens" value={formatNumber(totals.total_tokens)} type="tokens" subtitle="Input + output" />
        <KPICard title="Input Tokens" value={formatNumber(totals.input_tokens)} type="tokens" subtitle="Prompt tokens" />
        <KPICard title="Output Tokens" value={formatNumber(totals.output_tokens)} type="tokens" subtitle="Generated tokens" />
      </div>

      {/* Filter Bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: "16px" }}>
        <FilterDropdown
          value={providerFilter}
          onChange={setProviderFilter}
          options={[
            { label: "All Providers", value: "All" },
            ...knownProviders.map((p) => ({ label: p, value: p })),
          ]}
          label="Provider"
        />
      </div>

      {/* Requests Over Time & Provider Distribution */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px" }}>
        <ChartCard title="AI Requests Over Time" subtitle={`Daily request trend for ${timeRange}`} height={280}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={timeSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="date" stroke="#71717a" fontSize={12} tickLine={false} />
              <YAxis stroke="#71717a" fontSize={12} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="requests" name="Requests" stroke="#22C55E" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="successful" name="Successful" stroke="#3B82F6" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="failed" name="Failed" stroke="#EF4444" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Provider Distribution" subtitle="Share of requests per LLM engine" height={280}>
          {providerDistribution.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              No provider data for this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={providerDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value" nameKey="name">
                  {providerDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* Requests by Model & Status / Request Type */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px" }}>
        <ChartCard title="Requests By Model" subtitle="Top 10 models by request volume" height={280}>
          {modelSeries.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              No model data for this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={modelSeries} margin={{ top: 10, right: 10, left: 40, bottom: 0 }}>
                <XAxis type="number" stroke="#71717a" fontSize={12} tickLine={false} />
                <YAxis dataKey="key" type="category" stroke="#71717a" fontSize={10} tickLine={false} width={140} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="requests" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <ChartCard title="Requests By Status" subtitle="Success vs failed distribution" height={130}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_status} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="key" stroke="#71717a" fontSize={11} tickLine={false} />
                <YAxis stroke="#71717a" fontSize={11} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="requests" fill="#22C55E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Requests By Request Type" subtitle="Chat vs screen-share analysis" height={130}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_request_type} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="key" stroke="#71717a" fontSize={11} tickLine={false} />
                <YAxis stroke="#71717a" fontSize={11} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="requests" fill="#A855F7" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>

      {/* Errors by Provider */}
      <ChartCard title="Errors By Provider" subtitle="Failed request counts per provider" height={260}>
        {errorSeries.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No failed requests recorded in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={errorSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="key" stroke="#71717a" fontSize={12} tickLine={false} />
              <YAxis stroke="#71717a" fontSize={12} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="failed" name="Failed Requests" fill="#EF4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "#18181b",
  borderColor: "#27272a",
  borderRadius: "8px",
  color: "#fff",
} as const;
