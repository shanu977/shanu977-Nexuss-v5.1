"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  Star,
  Cpu,
  MessageSquareQuote,
  ArrowRight,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { SearchBar } from "@/components/admin/SearchBar";
import { FilterDropdown } from "@/components/admin/FilterDropdown";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { SkeletonLoader, ErrorState, EmptyState } from "@/components/admin/States";
import { adminApi } from "@/services/admin";
import type { AdminFeedback, AdminFeedbackList, FeedbackStatus } from "@/types/admin";
import { formatDateTime } from "@/utils/format";

const DAY_MS = 86_400_000;

const starFilterOptions = [
  { label: "All Ratings", value: "All" },
  { label: "5 Stars", value: "5" },
  { label: "4 Stars", value: "4" },
  { label: "3 Stars", value: "3" },
  { label: "2 Stars", value: "2" },
  { label: "1 Star", value: "1" },
];

const dateRangeOptions = [
  { label: "All Time", value: "All Time" },
  { label: "Today", value: "Today" },
  { label: "7 Days", value: "7 Days" },
  { label: "30 Days", value: "30 Days" },
  { label: "3 Months", value: "3 Months" },
];

const sortOptions = [
  { label: "Newest", value: "Newest" },
  { label: "Oldest", value: "Oldest" },
  { label: "Highest Rating", value: "Highest Rating" },
  { label: "Lowest Rating", value: "Lowest Rating" },
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
    case "3 Months":
      return { from_ms: now - 90 * DAY_MS, to_ms: now };
    default:
      return {};
  }
}

function sortForLabel(label: string): { sort_by: "created_at" | "rating"; sort_dir: "asc" | "desc" } {
  switch (label) {
    case "Oldest":
      return { sort_by: "created_at", sort_dir: "asc" };
    case "Highest Rating":
      return { sort_by: "rating", sort_dir: "desc" };
    case "Lowest Rating":
      return { sort_by: "rating", sort_dir: "asc" };
    default:
      return { sort_by: "created_at", sort_dir: "desc" };
  }
}

function renderStars(rating: number | null) {
  const value = rating ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={16}
          fill={star <= value ? "#EAB308" : "none"}
          color={star <= value ? "#EAB308" : "#3A3F42"}
        />
      ))}
    </div>
  );
}

export default function AdminFeedbackPage() {
  const [feedbackData, setFeedbackData] = useState<AdminFeedbackList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [starFilter, setStarFilter] = useState("All");
  const [dateRange, setDateRange] = useState("All Time");
  const [sortBy, setSortBy] = useState("Newest");
  const [page, setPage] = useState(1);

  const [selectedFeedback, setSelectedFeedback] = useState<AdminFeedback | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchFeedback = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = rangeForDateFilter(dateRange);
      const sort = sortForLabel(sortBy);
      const res = await adminApi.getFeedback({
        page,
        page_size: 20,
        search: search || undefined,
        rating: starFilter === "All" ? undefined : Number(starFilter),
        from_ms: range.from_ms,
        to_ms: range.to_ms,
        sort_by: sort.sort_by,
        sort_dir: sort.sort_dir,
      });
      setFeedbackData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load chatbot feedback messages.");
    } finally {
      setLoading(false);
    }
  }, [search, starFilter, dateRange, sortBy, page]);

  useEffect(() => {
    fetchFeedback();
  }, [fetchFeedback]);

  const handleStatusUpdate = async (status: FeedbackStatus) => {
    if (!selectedFeedback) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const updated = await adminApi.updateFeedback(selectedFeedback.id, status);
      setSelectedFeedback(updated);
      setFeedbackData((prev) =>
        prev
          ? { ...prev, items: prev.items.map((i) => (i.id === updated.id ? updated : i)) }
          : prev
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to update feedback status.");
    } finally {
      setActionLoading(false);
    }
  };

  const pagination = feedbackData
    ? {
        page: feedbackData.page,
        totalPages: feedbackData.pages,
        totalCount: feedbackData.total,
      }
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>Feedback</h1>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>
          User feedback from the Nexuss chatbot
        </p>
      </div>

      {/* Controls & Filter Bar */}
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
        <SearchBar
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search feedback messages..."
        />

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <FilterDropdown
            value={starFilter}
            onChange={(val) => {
              setStarFilter(val);
              setPage(1);
            }}
            options={starFilterOptions}
            label="Star Rating"
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
            value={sortBy}
            onChange={(val) => {
              setSortBy(val);
              setPage(1);
            }}
            options={sortOptions}
            label="Sort By"
          />
        </div>
      </div>

      {actionError && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-danger-bg)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "var(--color-danger)",
            fontSize: "0.82rem",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ flex: 1 }}>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss" style={{ color: "var(--color-danger)" }}>
            <X size={16} />
          </button>
        </div>
      )}

      {loading && !feedbackData ? (
        <SkeletonLoader height="120px" count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchFeedback} />
      ) : !feedbackData || feedbackData.items.length === 0 ? (
        <EmptyState title="No feedback found" message="Try changing your filters or search query." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {feedbackData.items.map((item) => (
            <div
              key={item.id}
              className="admin-glass-panel"
              style={{
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {renderStars(item.rating)}
                  <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", marginLeft: "4px" }}>
                    {item.rating === null ? "No rating" : `${item.rating}.0`}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <StatusBadge status={item.status} />
                  <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--accent-primary)", fontFamily: "monospace" }}>
                    {item.id}
                  </span>
                </div>
              </div>

              <blockquote
                style={{
                  fontSize: "0.92rem",
                  color: "var(--text-primary)",
                  lineHeight: 1.5,
                  padding: "12px 16px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-app)",
                  borderLeft: "3px solid var(--accent-primary)",
                  fontStyle: "normal",
                  margin: 0,
                }}
              >
                "{item.message || "—"}"
              </blockquote>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "12px",
                  paddingTop: "8px",
                  borderTop: "1px solid var(--border-subtle)",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{item.user.name || item.user.email}</span>
                    {item.user.email && (
                      <span style={{ color: "var(--text-muted)", marginLeft: "8px" }}>({item.user.email})</span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>{formatDateTime(item.created_at)}</span>
                  <button
                    onClick={() => {
                      setSelectedFeedback(item);
                      setActionError(null);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: "var(--accent-primary)",
                      padding: "4px 10px",
                      borderRadius: "var(--radius-sm)",
                      backgroundColor: "var(--accent-primary-light)",
                    }}
                  >
                    View Details <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {pagination && pagination.totalPages > 1 && (
            <div
              className="admin-glass-panel"
              style={{
                padding: "14px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "12px",
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
              }}
            >
              <div>
                Showing page {pagination.page} of {pagination.totalPages} ({pagination.totalCount} items)
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page <= 1}
                  style={pagerBtnStyle(page <= 1)}
                >
                  <ChevronLeft size={14} /> Previous
                </button>
                <span style={{ fontWeight: 600, color: "var(--text-primary)", padding: "0 4px" }}>
                  Page {page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page >= pagination.totalPages}
                  style={pagerBtnStyle(page >= pagination.totalPages)}
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {selectedFeedback && (
        <div className="admin-modal-overlay" onClick={() => setSelectedFeedback(null)}>
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
                <MessageSquareQuote size={22} style={{ color: "var(--accent-primary)" }} />
                <div>
                  <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>FEEDBACK DETAILS</h3>
                  <div style={{ fontSize: "0.78rem", color: "var(--accent-primary)", fontFamily: "monospace", fontWeight: 600 }}>
                    {selectedFeedback.id}
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedFeedback(null)} aria-label="Close" style={{ color: "var(--text-muted)", padding: "4px" }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ padding: "16px", borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {renderStars(selectedFeedback.rating)}
                <span style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "0.9rem" }}>
                  {selectedFeedback.rating === null ? "No rating" : `${selectedFeedback.rating}.0 / 5.0`}
                </span>
              </div>
              <p style={{ fontSize: "0.92rem", color: "var(--text-primary)", lineHeight: 1.5, margin: 0 }}>
                "{selectedFeedback.message || "—"}"
              </p>
              <div>
                <StatusBadge status={selectedFeedback.status} />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                USER INFORMATION
              </div>
              <div style={{ padding: "12px", borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-subtle)", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", fontSize: "0.82rem" }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>User ID</div>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-all" }}>{selectedFeedback.user.id}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>User Name</div>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{selectedFeedback.user.name || "—"}</div>
                </div>
                <div style={{ gridColumn: "span 2" }}>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>User Email</div>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{selectedFeedback.user.email || "—"}</div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                SUBMISSION
              </div>
              <div style={{ padding: "12px", borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-subtle)", fontSize: "0.82rem" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Date & Time</div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{formatDateTime(selectedFeedback.created_at)}</div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                TRIAGE STATUS
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {(["new", "reviewed", "closed"] as FeedbackStatus[]).map((status) => {
                  const active = selectedFeedback.status === status;
                  return (
                    <button
                      key={status}
                      disabled={active || actionLoading}
                      onClick={() => handleStatusUpdate(status)}
                      style={{
                        padding: "6px 14px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        borderRadius: "var(--radius-md)",
                        color: active ? "var(--accent-primary)" : "var(--text-secondary)",
                        backgroundColor: active ? "var(--accent-primary-light)" : "var(--bg-app)",
                        border: active ? "1px solid var(--accent-primary)" : "1px solid var(--border-color)",
                        opacity: active || actionLoading ? 0.8 : 1,
                        cursor: active ? "default" : "pointer",
                      }}
                    >
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--text-muted)", fontSize: "0.78rem" }}>
                <Cpu size={14} style={{ color: "var(--accent-primary)" }} />
                Updating the triage status is recorded in the admin audit trail.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pagerBtnStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--bg-app)",
    border: "1px solid var(--border-color)",
    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: "4px",
  };
}
