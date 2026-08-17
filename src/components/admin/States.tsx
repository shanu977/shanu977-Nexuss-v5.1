import { Database, AlertCircle, RefreshCw } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  message?: string;
}

export function EmptyState({ title = "No data available", message = "There are no items to display right now." }: EmptyStateProps) {
  return (
    <div
      className="admin-glass-panel"
      style={{
        padding: "48px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "12px",
      }}
    >
      <div
        style={{
          width: "48px",
          height: "48px",
          borderRadius: "var(--radius-full)",
          backgroundColor: "var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
        }}
      >
        <Database size={24} />
      </div>
      <h4 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h4>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "360px" }}>{message}</p>
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Unable to load data", message = "An error occurred while loading this data.", onRetry }: ErrorStateProps) {
  return (
    <div
      className="admin-glass-panel"
      style={{
        padding: "40px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "14px",
        borderColor: "rgba(244, 63, 94, 0.3)",
      }}
    >
      <div
        style={{
          width: "48px",
          height: "48px",
          borderRadius: "var(--radius-full)",
          backgroundColor: "var(--color-danger-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-danger)",
        }}
      >
        <AlertCircle size={24} />
      </div>
      <h4 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h4>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "360px" }}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 16px",
            fontSize: "0.82rem",
            fontWeight: 600,
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--border-subtle)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-color)",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  );
}

interface SkeletonLoaderProps {
  height?: string;
  count?: number;
}

export function SkeletonLoader({ height = "100px", count = 1 }: SkeletonLoaderProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="admin-skeleton"
          style={{
            width: "100%",
            height,
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
          }}
        />
      ))}
    </div>
  );
}
