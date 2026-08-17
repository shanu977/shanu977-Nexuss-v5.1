"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Cpu,
  MessageSquareQuote,
  Settings,
  ShieldAlert,
  LogOut,
  X,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { NexussLogo } from "@/components/admin/NexussLogo";
import { useAuthStore } from "@/store/useAuthStore";

export const ADMIN_NAV: { path: string; label: string; icon: LucideIcon }[] = [
  { path: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/admin/users", label: "Users", icon: Users },
  { path: "/admin/ai-usage", label: "AI Usage", icon: Cpu },
  { path: "/admin/feedback", label: "Feedback", icon: MessageSquareQuote },
  { path: "/admin/settings", label: "Settings", icon: Settings },
  { path: "/admin/security", label: "Security", icon: ShieldAlert },
];

interface AdminSidebarProps {
  onCloseMobile?: () => void;
}

export function AdminSidebar({ onCloseMobile }: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const signOut = useAuthStore((s) => s.signOut);

  const handleLogout = async () => {
    await signOut();
    router.replace("/admin/login");
  };

  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-color)",
        padding: "20px 16px",
        width: "240px",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: "20px",
          marginBottom: "16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <Link href="/admin/dashboard" style={{ display: "flex", alignItems: "center", gap: "12px", textDecoration: "none" }}>
          <NexussLogo size={32} color="#ffffff" />
          <div>
            <div style={{ fontSize: "1.15rem", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", lineHeight: 1.1 }}>
              Nexuss
            </div>
            <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em" }}>
              ADMIN PANEL
            </div>
          </div>
        </Link>

        {onCloseMobile && (
          <button onClick={onCloseMobile} aria-label="Close menu" style={{ color: "var(--text-muted)", padding: "4px" }}>
            <X size={20} />
          </button>
        )}
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1 }}>
        {ADMIN_NAV.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.path || (item.path !== "/admin/dashboard" && pathname.startsWith(item.path));
          return (
            <Link
              key={item.path}
              href={item.path}
              onClick={() => onCloseMobile && onCloseMobile()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "10px 14px",
                borderRadius: "var(--radius-md)",
                fontSize: "0.88rem",
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                backgroundColor: isActive ? "var(--accent-primary-light)" : "transparent",
                borderLeft: isActive ? "3px solid var(--accent-primary)" : "3px solid transparent",
                textDecoration: "none",
                transition: "all var(--transition-fast)",
              }}
            >
              <Icon size={18} style={{ color: isActive ? "var(--accent-primary)" : "inherit" }} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div
        style={{
          paddingTop: "16px",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            fontSize: "0.88rem",
            fontWeight: 500,
            color: "var(--text-secondary)",
            textDecoration: "none",
            transition: "background-color var(--transition-fast)",
          }}
        >
          <ExternalLink size={18} />
          <span>Back to app</span>
        </Link>
        <button
          onClick={handleLogout}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            fontSize: "0.88rem",
            fontWeight: 500,
            color: "var(--color-danger)",
            backgroundColor: "transparent",
            transition: "background-color var(--transition-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--color-danger-bg)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <LogOut size={18} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
