import {
  TrendingUp,
  TrendingDown,
  Users,
  Activity,
  Cpu,
  Monitor,
  Share2,
  AlertTriangle,
  Coins,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  users: Users,
  active: Activity,
  ai: Cpu,
  tokens: Coins,
  screenshare: Monitor,
  path: Share2,
  errors: AlertTriangle,
  success: CheckCircle2,
  failed: XCircle,
};

interface KPICardProps {
  title: string;
  value: string | number;
  change?: string;
  isPositive?: boolean;
  subtitle?: string;
  type?: string;
}

export function KPICard({ title, value, change, isPositive, subtitle, type }: KPICardProps) {
  const IconComponent = iconMap[type || ""] || Activity;

  return (
    <div
      className="admin-glass-panel"
      style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 500, color: "var(--text-secondary)" }}>
          {title}
        </span>
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "var(--radius-md)",
            background: "var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-primary)",
          }}
        >
          <IconComponent size={18} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginTop: "4px" }}>
        <span style={{ fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>
          {value}
        </span>
        {change && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "0.78rem",
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: "var(--radius-full)",
              backgroundColor: isPositive ? "var(--color-success-bg)" : "var(--color-danger-bg)",
              color: isPositive ? "var(--color-success)" : "var(--color-danger)",
            }}
          >
            {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            <span>{change}</span>
          </div>
        )}
      </div>

      {subtitle && (
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{subtitle}</span>
      )}
    </div>
  );
}
