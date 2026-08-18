"use client";

import { useState, type ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminHeader } from "./AdminHeader";

export function AdminLayout({ children }: { children: ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="admin-viewport" style={{ display: "flex", width: "100%", overflow: "hidden", backgroundColor: "var(--bg-app)" }}>
      <div className="admin-desktop-sidebar" style={{ height: "100%" }}>
        <AdminSidebar />
      </div>

      {mobileMenuOpen && (
        <div
          className="admin-modal-overlay"
          onClick={() => setMobileMenuOpen(false)}
          style={{ justifyContent: "flex-start", padding: 0 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ height: "100%", animation: "admin-slide-up 0.2s ease-out" }}>
            <AdminSidebar onCloseMobile={() => setMobileMenuOpen(false)} />
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", minWidth: 0 }}>
        <AdminHeader onOpenMobileMenu={() => setMobileMenuOpen(true)} />

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px",
            backgroundColor: "var(--bg-app)",
          }}
        >
          <div style={{ maxWidth: "1400px", margin: "0 auto" }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
