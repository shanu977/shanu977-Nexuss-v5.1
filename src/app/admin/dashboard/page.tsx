"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { ArrowRight, Eye } from "lucide-react";
import { KPICard } from "@/components/admin/KPICard";
import { ChartCard } from "@/components/admin/ChartCard";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { SkeletonLoader, ErrorState } from "@/components/admin/States";
import { adminApi } from "@/services/admin";
import type { AdminUser, AiUsageResponse, AnalyticsSummary } from "@/types/admin";
import { formatDate, formatNumber } from "@/utils/format";

const PRESETS = ["Today", "7 Days", "30 Days", "Custom"] as const;
type Preset = (typeof PRESETS)[number];

const DAY_MS = 86_400_000;
const CHART_COLORS = ["#22C55E", "#3B82F6", "#A855F7", "#F59E0B", "#06B6D4", "#EF4444", "#6366F1"];

function presetRange(preset: Preset): { from_ms?: number; to_ms?: number } {
  const now = new Date();
  const to = now.getTime();
  switch (preset) {
    case "Today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from_ms: start.getTime(), to_ms: to };
    }
    case "7 Days":
      return { from_ms: to - 7 * DAY_MS, to_ms: to };
    case "30 Days":
      return { from_ms: to - 30 * DAY_MS, to_ms: to };
    default:
      return {};
  }
}

function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

interface DashboardData {
  summary: AnalyticsSummary;
  usage: AiUsageResponse;
  recentUsers: AdminUser[];
  totalUsers: number;
}

export default function AdminDashboardPage() {
  const [preset, setPreset] = useState<Preset>("7 Days");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = preset === "Custom" ? { from_ms: undefined, to_ms: undefined } : presetRange(preset);
      const [summary, usage, users] = await Promise.all([
        adminApi.getAnalyticsSummary(range),
        adminApi.getAiUsage(range),
        adminApi.getUsers({ page: 1, page_size: 5, sort_by: "created_at", sort_dir: "desc" }),
      ]);
      setData({
        summary,
        usage,
        recentUsers: users.items,
        totalUsers: users.total,
      });
    } catch {
      setError("Failed to load Nexuss dashboard metrics.");
    } finally {
      setLoading(false);
    }
  }, [preset]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (loading && !data) {
    return <SkeletonLoader height="120px" count={4} />;
  }

  if (error || !data) {
    return <ErrorState message={error || "No data available."} onRetry={fetchDashboard} />;
  }

  const totals = data.summary.totals;
  const providerDistribution = data.usage.by_provider.map((p, i) => ({
    name: p.key,
    value: p.requests,
    color: CHART_COLORS[i % CHART_COLORS.length],
    percentage: `${percent(p.requests, totals.total_requests)}%`,
  }));
  const usageTrends = data.usage.series.map((d) => ({
    date: d.date,
    total: d.requests,
    successful: d.successful,
    failed: d.failed,
  }));
  const topModels = data.usage.by_model.slice(0, 5).map((m, idx) => ({
    rank: idx + 1,
    name: m.key,
    count: m.requests,
    percentage: percent(m.requests, totals.total_requests),
  }));
  const centerTotal = formatNumber(totals.total_requests);

  const selectCustom = () => {
    setPreset("Custom");
    const start = new Date();
    start.setDate(start.getDate() - 7);
    setCustomFrom(start.toISOString().slice(0, 10));
    setCustomTo(new Date().toISOString().slice(0, 10));
  };

  const customRangeMs = () => {
    if (!customFrom || !customTo) return {};
    const from = new Date(`${customFrom}T00:00:00`).getTime();
    const to = new Date(`${customTo}T23:59:59`).getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) return {};
    return { from_ms: from, to_ms: to };
  };

  const applyCustom = () => {
    setError(null);
    setLoading(true);
    const range = customRangeMs();
    Promise.all([
      adminApi.getAnalyticsSummary(range),
      adminApi.getAiUsage(range),
      adminApi.getUsers({ page: 1, page_size: 5, sort_by: "created_at", sort_dir: "desc" }),
    ])
      .then(([summary, usage, users]) =>
        setData({ summary, usage, recentUsers: users.items, totalUsers: users.total })
      )
      .catch(() => setError("Failed to load Nexuss dashboard metrics."))
      .finally(() => setLoading(false));
  };

  const rangeLabel = preset === "Custom" ? "custom range" : preset.toLowerCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* KPI row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
        <KPICard title="Total Users" value={formatNumber(totals.total_users)} type="users" subtitle="Registered accounts" />
        <KPICard title="Active Users" value={formatNumber(totals.active_users)} type="active" subtitle="Used AI in this period" />
        <KPICard title="Total Requests" value={formatNumber(totals.total_requests)} type="ai" subtitle="All provider attempts" />
        <KPICard title="Successful Requests" value={formatNumber(totals.successful_requests)} type="success" subtitle="Completed attempts" />
        <KPICard title="Failed Requests" value={formatNumber(totals.failed_requests)} type="failed" subtitle="Provider errors" />
      </div>

      {/* KPI row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
        <KPICard title="Total Tokens" value={formatNumber(totals.total_tokens)} type="tokens" subtitle="Input + output" />
        <KPICard title="Input Tokens" value={formatNumber(totals.input_tokens)} type="tokens" subtitle="Prompt tokens" />
        <KPICard title="Output Tokens" value={formatNumber(totals.output_tokens)} type="tokens" subtitle="Generated tokens" />
        <KPICard title="Requests Today" value={formatNumber(totals.requests_today)} type="active" subtitle="Since UTC midnight" />
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px" }}>
        <ChartCard
          title="AI Requests Overview"
          subtitle={`Requests per day for the ${rangeLabel}`}
          action={
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "4px",
                backgroundColor: "var(--bg-app)",
                padding: "3px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-color)",
              }}
            >
              {PRESETS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => (opt === "Custom" ? selectCustom() : setPreset(opt))}
                  style={{
                    padding: "4px 10px",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    color: preset === opt ? "var(--text-primary)" : "var(--text-muted)",
                    backgroundColor: preset === opt ? "var(--bg-card)" : "transparent",
                    border: preset === opt ? "1px solid var(--border-color)" : "none",
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          }
          height={300}
        >
          {preset === "Custom" && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={dateInputStyle}
              />
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={dateInputStyle}
              />
              <button onClick={applyCustom} style={{ ...applyBtnStyle }}>
                Apply
              </button>
            </div>
          )}
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={usageTrends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="date" stroke="#6F767A" fontSize={12} tickLine={false} />
              <YAxis stroke="#6F767A" fontSize={12} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="total" name="Total Requests" stroke="#22C55E" strokeWidth={2.5} dot={{ fill: "#22C55E", r: 4 }} />
              <Line type="monotone" dataKey="successful" name="Successful" stroke="#3B82F6" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="failed" name="Failed" stroke="#EF4444" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Requests By Provider" subtitle="Provider distribution share" height={300}>
          <div style={{ display: "flex", alignItems: "center", height: "100%", position: "relative" }}>
            <div style={{ flex: 1, height: "100%", position: "relative" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={providerDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={90}
                    paddingAngle={4}
                    dataKey="value"
                    nameKey="name"
                  >
                    {providerDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  textAlign: "center",
                  pointerEvents: "none",
                }}
              >
                <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "var(--text-primary)", lineHeight: 1.1 }}>
                  {centerTotal}
                </div>
                <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontWeight: 600 }}>Total Requests</div>
              </div>
            </div>

            <div style={{ width: "130px", display: "flex", flexDirection: "column", gap: "10px" }}>
              {providerDistribution.map((prov) => (
                <div key={prov.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.8rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: prov.color }} />
                    <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{prov.name}</span>
                  </div>
                  <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{prov.percentage}</span>
                </div>
              ))}
            </div>
          </div>
        </ChartCard>
      </div>

      {/* Top Models */}
      <div className="admin-glass-panel" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>Top Models</h3>
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Most used AI models in this period</p>
          </div>
        </div>

        {topModels.length === 0 ? (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "8px 0" }}>
            No model usage recorded in this period.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {topModels.map((item) => (
              <div key={item.name} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--accent-primary)", width: "16px" }}>{item.rank}</span>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{item.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "0.8rem" }}>
                    <span style={{ color: "var(--text-secondary)" }}>{formatNumber(item.count)} requests</span>
                    <span style={{ fontWeight: 700, color: "var(--accent-primary)" }}>{item.percentage}%</span>
                  </div>
                </div>
                <div style={{ width: "100%", height: "7px", backgroundColor: "var(--border-color)", borderRadius: "var(--radius-full)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${item.percentage}%`,
                      height: "100%",
                      backgroundColor: "var(--accent-primary)",
                      borderRadius: "var(--radius-full)",
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Users */}
      <div className="admin-glass-panel" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>Recent Users</h3>
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Most recently registered accounts on Nexuss</p>
          </div>
          <Link
            href="/admin/users"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "var(--accent-primary)",
              padding: "6px 12px",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--accent-primary-light)",
              textDecoration: "none",
            }}
          >
            View All Users <ArrowRight size={14} />
          </Link>
        </div>

        <div style={{ width: "100%", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)", color: "var(--text-muted)" }}>
                <th style={{ padding: "10px 14px", fontWeight: 600 }}>User</th>
                <th style={{ padding: "10px 14px", fontWeight: 600 }}>Role</th>
                <th style={{ padding: "10px 14px", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "10px 14px", fontWeight: 600 }}>Joined</th>
                <th style={{ padding: "10px 14px", fontWeight: 600 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.recentUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "24px 14px", textAlign: "center", color: "var(--text-muted)" }}>
                    No registered users yet.
                  </td>
                </tr>
              ) : (
                data.recentUsers.map((user) => (
                  <tr key={user.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "12px 14px", fontWeight: 600, color: "var(--text-primary)" }}>{user.name || user.email}</td>
                    <td style={{ padding: "12px 14px", color: "var(--text-secondary)" }}>{user.role}</td>
                    <td style={{ padding: "12px 14px" }}>
                      <StatusBadge status={user.status} />
                    </td>
                    <td style={{ padding: "12px 14px", color: "var(--text-muted)" }}>{formatDate(user.created_at)}</td>
                    <td style={{ padding: "12px 14px" }}>
                      <Link href="/admin/users" title="View User" style={{ padding: "4px", color: "var(--text-secondary)", display: "inline-flex" }}>
                        <Eye size={16} />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "#111416",
  borderColor: "#25292B",
  borderRadius: "8px",
  color: "#F5F5F5",
} as const;

const dateInputStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: "0.8rem",
  color: "var(--text-primary)",
  backgroundColor: "var(--bg-input)",
  border: "1px solid var(--border-color)",
  borderRadius: "var(--radius-md)",
};

const applyBtnStyle: CSSProperties = {
  padding: "6px 14px",
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "#ffffff",
  backgroundColor: "var(--accent-primary)",
  borderRadius: "var(--radius-md)",
  border: "none",
};
