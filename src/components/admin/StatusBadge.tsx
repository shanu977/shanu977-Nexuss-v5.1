interface StatusBadgeProps {
  status: string | null | undefined;
}

const DANGER = new Set(["blocked", "abandoned", "error", "failed", "closed"]);
const WARNING = new Set(["pending", "in progress", "disconnected"]);
const SUCCESS = new Set(["resolved", "completed", "active", "reviewed", "success"]);

export function StatusBadge({ status }: StatusBadgeProps) {
  const normalized = status ? status.toLowerCase() : "active";

  let bg = "var(--color-success-bg)";
  let color = "var(--color-success)";

  if (DANGER.has(normalized)) {
    bg = "var(--color-danger-bg)";
    color = "var(--color-danger)";
  } else if (WARNING.has(normalized)) {
    bg = "var(--color-warning-bg)";
    color = "var(--color-warning)";
  } else if (normalized === "investigating" || normalized === "admin") {
    bg = "var(--color-purple-bg)";
    color = "var(--color-purple)";
  } else if (normalized === "new") {
    bg = "var(--color-info-bg)";
    color = "var(--color-info)";
  } else if (SUCCESS.has(normalized)) {
    bg = "var(--color-success-bg)";
    color = "var(--color-success)";
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px",
        borderRadius: "var(--radius-full)",
        fontSize: "0.75rem",
        fontWeight: 600,
        backgroundColor: bg,
        color,
      }}
    >
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: color }} />
      {status || "active"}
    </span>
  );
}
