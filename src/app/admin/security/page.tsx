"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, X, RefreshCw, Eye } from "lucide-react";
import { SearchBar } from "@/components/admin/SearchBar";
import { FilterDropdown } from "@/components/admin/FilterDropdown";
import { SkeletonLoader, ErrorState, EmptyState } from "@/components/admin/States";
import { DataTable, type ColumnDef } from "@/components/admin/DataTable";
import { adminApi } from "@/services/admin";
import type { AuditLogEntry, AuditLogList } from "@/types/admin";
import { formatDateTime } from "@/utils/format";

const DAY_MS = 86_400_000;

const actionOptions = [
  { label: "All Actions", value: "All" },
  { label: "user.created", value: "user.created" },
  { label: "user.login", value: "user.login" },
  { label: "user.logout", value: "user.logout" },
  { label: "user.role.updated", value: "user.role.updated" },
  { label: "user.blocked", value: "user.blocked" },
  { label: "user.unblocked", value: "user.unblocked" },
  { label: "user.deleted", value: "user.deleted" },
  { label: "feedback.status.updated", value: "feedback.status.updated" },
  { label: "settings.updated", value: "settings.updated" },
  { label: "settings.created", value: "settings.created" },
];

const targetTypeOptions = [
  { label: "All Target Types", value: "All" },
  { label: "user", value: "user" },
  { label: "feedback", value: "feedback" },
  { label: "app_settings", value: "app_settings" },
  { label: "auth", value: "auth" },
];

const dateRangeOptions = [
  { label: "All Time", value: "All Time" },
  { label: "Today", value: "Today" },
  { label: "7 Days", value: "7 Days" },
  { label: "30 Days", value: "30 Days" },
];

const sortOptions = [
  { label: "Newest First", value: "desc" },
  { label: "Oldest First", value: "asc" },
];

function rangeForDateFilter(label: string): { from_ms?: number; to_ms?: number } {
  const now = Date.now();
  switch (label) {
    case "Today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from_ms: start.getTime(), to_ms: now };
    }
    case "7 Days":
      return { from_ms: now - 7 * DAY_MS, to_ms: now };
    case "30 Days":
      return { from_ms: now - 30 * DAY_MS, to_ms: now };
    default:
      return {};
  }
}

function actionTone(action: string): "green" | "danger" | "info" | "warning" | "neutral" {
  if (action.includes("deleted") || action.includes("blocked") || action.includes("failed")) return "danger";
  if (action.includes("login") || action.includes("created") || action.includes("unblocked")) return "green";
  if (action.includes("role") || action.includes("status")) return "warning";
  if (action.includes("settings") || action.includes("logout")) return "info";
  return "neutral";
}

const ACTION_TONE_COLORS: Record<string, string> = {
  green: "#22C55E",
  danger: "#EF4444",
  info: "#3B82F6",
  warning: "#F59E0B",
  neutral: "#8B5CF6",
};

function ActionBadge({ action }: { action: string }) {
  const tone = actionTone(action);
  const color = ACTION_TONE_COLORS[tone];
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.72rem",
        fontWeight: 700,
        fontFamily: "monospace",
        padding: "3px 8px",
        borderRadius: "var(--radius-full)",
        color,
        backgroundColor: `${color}1A`,
        border: `1px solid ${color}40`,
        whiteSpace: "nowrap",
      }}
    >
      {action}
    </span>
  );
}

function TargetBadge({ targetType }: { targetType: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.72rem",
        fontWeight: 600,
        padding: "3px 8px",
        borderRadius: "var(--radius-full)",
        color: "var(--accent-primary)",
        backgroundColor: "var(--accent-primary-light)",
        border: "1px solid var(--accent-primary)",
        whiteSpace: "nowrap",
      }}
    >
      {targetType}
    </span>
  );
}

export default function AdminSecurityPage() {
  const [auditData, setAuditData] = useState<AuditLogList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("All");
  const [targetFilter, setTargetFilter] = useState("All");
  const [dateRange, setDateRange] = useState("All Time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = rangeForDateFilter(dateRange);
      const res = await adminApi.getAudit({
        page,
        page_size: 25,
        search: search || undefined,
        action: actionFilter === "All" ? undefined : actionFilter,
        target_type: targetFilter === "All" ? undefined : targetFilter,
        from_ms: range.from_ms,
        to_ms: range.to_ms,
        sort_dir: sortDir,
      });
      setAuditData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the security audit trail.");
    } finally {
      setLoading(false);
    }
  }, [search, actionFilter, targetFilter, dateRange, sortDir, page]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const columns = useMemo<ColumnDef<AuditLogEntry>[]>(() => {
    return [
      {
        key: "created_at",
        header: "Timestamp",
        render: (row) => <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{formatDateTime(row.created_at)}</span>,
      },
      {
        key: "admin_email",
        header: "Admin",
        render: (row) => (
          <div>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>{row.admin_name || row.admin_email || "—"}</div>
            {row.admin_email && row.admin_name && (
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{row.admin_email}</div>
            )}
          </div>
        ),
      },
      {
        key: "action",
        header: "Action",
        render: (row) => <ActionBadge action={row.action} />,
      },
      {
        key: "target_type",
        header: "Target",
        render: (row) => (row.target_type ? <TargetBadge targetType={row.target_type} /> : <span style={{ color: "var(--text-muted)" }}>—</span>),
      },
      {
        key: "target_id",
        header: "Target ID",
        render: (row) => (
          <span style={{ fontSize: "0.76rem", color: "var(--text-secondary)", fontFamily: "monospace", wordBreak: "break-all" }}>
            {row.target_id || "—"}
          </span>
        ),
      },
      {
        key: "ip_address",
        header: "IP",
        render: (row) => (
          <span style={{ fontSize: "0.76rem", color: "var(--text-muted)", fontFamily: "monospace" }}>{row.ip_address || "—"}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        render: (row) => (
          <button
            onClick={() => setSelectedLog(row)}
            aria-label="View details"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.78rem",
              fontWeight: 600,
              color: "var(--accent-primary)",
              padding: "4px 8px",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--accent-primary-light)",
            }}
          >
            <Eye size={14} /> View
          </button>
        ),
      },
    ];
  }, []);

  const pagination = auditData
    ? { page: auditData.page, totalPages: auditData.pages, totalCount: auditData.total }
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>Security & Audit</h1>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>
          Real audit trail of admin and user actions. Non-sensitive data only.
        </p>
      </div>

      <div
        className="admin-glass-panel"
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: "260px" }}>
          <SearchBar
            value={search}
            onChange={(val) => {
              setSearch(val);
              setPage(1);
            }}
            placeholder="Search actions, targets, IPs..."
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <FilterDropdown
            value={actionFilter}
            onChange={(val) => {
              setActionFilter(val);
              setPage(1);
            }}
            options={actionOptions}
            label="Action"
          />
          <FilterDropdown
            value={targetFilter}
            onChange={(val) => {
              setTargetFilter(val);
              setPage(1);
            }}
            options={targetTypeOptions}
            label="Target"
          />
          <FilterDropdown
            value={dateRange}
            onChange={(val) => {
              setDateRange(val);
              setPage(1);
            }}
            options={dateRangeOptions}
            label="Date Range"
          />
          <FilterDropdown
            value={sortDir}
            onChange={(val) => {
              setSortDir(val as "asc" | "desc");
              setPage(1);
            }}
            options={sortOptions}
            label="Sort"
          />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={fetchAudit}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "var(--text-secondary)",
            padding: "6px 12px",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "var(--bg-app)",
            border: "1px solid var(--border-color)",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={14} style={loading ? { animation: "admin-spin 0.8s linear infinite" } : undefined} />
          Refresh
        </button>
      </div>

      {loading && !auditData ? (
        <SkeletonLoader height="64px" count={8} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchAudit} />
      ) : !auditData || auditData.items.length === 0 ? (
        <EmptyState
          title="No audit events"
          message="There are no audit events matching your filters. The trail records admin actions and user sign-ins."
        />
      ) : (
        <DataTable
          columns={columns}
          data={auditData.items}
          pagination={pagination}
          onPageChange={setPage}
          emptyMessage="No audit events"
        />
      )}

      {selectedLog && (
        <div className="admin-modal-overlay" onClick={() => setSelectedLog(null)}>
          <div
            className="admin-glass-panel admin-animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "560px",
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <ShieldCheck size={22} style={{ color: "var(--accent-primary)" }} />
                <div>
                  <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>AUDIT EVENT</h3>
                  <div style={{ fontSize: "0.78rem", color: "var(--accent-primary)", fontFamily: "monospace", fontWeight: 600 }}>
                    {selectedLog.id}
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedLog(null)} aria-label="Close" style={{ color: "var(--text-muted)", padding: "4px" }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
              <ActionBadge action={selectedLog.action} />
              {selectedLog.target_type && <TargetBadge targetType={selectedLog.target_type} />}
            </div>

            <div style={{ padding: "16px", borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-subtle)", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", fontSize: "0.82rem" }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Timestamp</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{formatDateTime(selectedLog.created_at)}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>IP Address</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)", fontFamily: "monospace" }}>{selectedLog.ip_address || "—"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Admin</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{selectedLog.admin_name || selectedLog.admin_email || "—"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Admin User ID</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-all" }}>{selectedLog.admin_user_id || "—"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Target Type</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{selectedLog.target_type || "—"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Target ID</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-all" }}>{selectedLog.target_id || "—"}</div>
              </div>
            </div>

            <div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                DETAILS
              </div>
              <pre
                style={{
                  marginTop: "8px",
                  padding: "14px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-app)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: "0.78rem",
                  color: "var(--text-secondary)",
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: "220px",
                  overflowY: "auto",
                }}
              >
                {selectedLog.details ? JSON.stringify(selectedLog.details, null, 2) : "No additional details"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
