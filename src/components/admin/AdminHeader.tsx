"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, ChevronDown, Calendar } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";

const routeTitles: Record<string, { title: string; desc: string }> = {
  "/admin/dashboard": { title: "Dashboard", desc: "Overview of your Nexuss platform" },
  "/admin/users": { title: "Users", desc: "Manage user accounts, roles, and access" },
  "/admin/ai-usage": { title: "AI Usage", desc: "Track and analyze AI requests across providers" },
  "/admin/feedback": { title: "Feedback", desc: "User feedback from the Nexuss chatbot" },
  "/admin/settings": { title: "Settings", desc: "Configure global platform features and settings" },
  "/admin/security": { title: "Security", desc: "Admin action audit trail" },
};

interface AdminHeaderProps {
  onOpenMobileMenu: () => void;
}

function Avatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt="Admin"
        style={{ width: "30px", height: "30px", borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }
  const initials = (name || "A").trim().charAt(0).toUpperCase() || "A";
  return (
    <div
      style={{
        width: "30px",
        height: "30px",
        borderRadius: "50%",
        backgroundColor: "var(--accent-primary-light)",
        color: "var(--accent-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: "0.85rem",
      }}
    >
      {initials}
    </div>
  );
}

export function AdminHeader({ onOpenMobileMenu }: AdminHeaderProps) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [currentDateTime, setCurrentDateTime] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentDateTime(
        now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) +
          " • " +
          now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 30000);
    return () => clearInterval(interval);
  }, []);

  const routeInfo = routeTitles[pathname] || { title: "Admin Console", desc: "Nexuss Enterprise Management" };

  return (
    <header
      style={{
        height: "70px",
        backgroundColor: "var(--bg-sidebar)",
        borderBottom: "1px solid var(--border-color)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <button
          onClick={onOpenMobileMenu}
          className="admin-mobile-menu-btn"
          aria-label="Open menu"
          style={{ color: "var(--text-secondary)", padding: "4px", display: "flex", alignItems: "center" }}
        >
          <Menu size={22} />
        </button>

        <div>
          <h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
            {routeInfo.title}
          </h2>
          <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{routeInfo.desc}</p>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        <div
          className="admin-header-datetime"
          style={{ alignItems: "center", gap: "6px", fontSize: "0.78rem", color: "var(--text-muted)" }}
        >
          <Calendar size={14} style={{ color: "var(--accent-primary)" }} />
          <span>{currentDateTime}</span>
        </div>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "4px 10px",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-color)",
              color: "var(--text-primary)",
            }}
          >
            <Avatar name={user?.displayName || user?.email || "Admin"} photoUrl={user?.photoURL} />
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.1 }}>
                {user?.displayName || "Admin"}
              </div>
              <div style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Administrator</div>
            </div>
            <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
          </button>

          {showUserMenu && (
            <div
              className="admin-glass-panel admin-animate-slide-up"
              style={{
                position: "absolute",
                right: 0,
                top: "46px",
                width: "220px",
                padding: "8px",
                boxShadow: "var(--shadow-card)",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ padding: "8px", borderBottom: "1px solid var(--border-subtle)", fontSize: "0.78rem" }}>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{user?.displayName || "Nexuss Admin"}</div>
                <div style={{ color: "var(--text-muted)", wordBreak: "break-all" }}>{user?.email || ""}</div>
              </div>
              <button
                onClick={signOut}
                style={{ textAlign: "left", padding: "8px", fontSize: "0.8rem", color: "var(--color-danger)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
