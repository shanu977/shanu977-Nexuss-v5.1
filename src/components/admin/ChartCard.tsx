import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  height?: number;
  children: ReactNode;
}

export function ChartCard({ title, subtitle, action, children, height = 300 }: ChartCardProps) {
  return (
    <div
      className="admin-glass-panel"
      style={{
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div>
          <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>
            {title}
          </h3>
          {subtitle && (
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "2px" }}>
              {subtitle}
            </p>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>

      <div style={{ width: "100%", height: `${height}px`, position: "relative" }}>{children}</div>
    </div>
  );
}
