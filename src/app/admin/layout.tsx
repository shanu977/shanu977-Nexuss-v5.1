"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { adminApi } from "@/services/admin";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { NexussLogo } from "@/components/admin/NexussLogo";
import "./admin.css";

type Access = "checking" | "admin" | "denied";

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  const { user, initialized, initAuth } = useAuthStore();
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/admin/login";
  const [access, setAccess] = useState<Access>(isLoginPage ? "admin" : "checking");

  useEffect(() => {
    const unsubscribe = initAuth();
    return () => unsubscribe();
  }, [initAuth]);

  useEffect(() => {
    if (isLoginPage) {
      setAccess("admin");
      return;
    }
    if (!initialized) {
      setAccess("checking");
      return;
    }
    if (!user) {
      router.replace("/admin/login");
      return;
    }
    let active = true;
    setAccess("checking");
    // UX-only guard. The backend enforces admin authorization on /admin/*.
    adminApi
      .isAdmin()
      .then((ok) => {
        if (active) setAccess(ok ? "admin" : "denied");
      })
      .catch(() => {
        if (active) setAccess("denied");
      });
    return () => {
      active = false;
    };
  }, [isLoginPage, initialized, user, router]);

  if (isLoginPage) {
    return <div className="admin-scope">{children}</div>;
  }

  if (access === "checking") {
    return (
      <div
        className="admin-scope"
        style={{
          height: "100vh",
          width: "100vw",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          backgroundColor: "var(--bg-app)",
          color: "var(--text-secondary)",
          fontSize: "0.9rem",
        }}
      >
        <NexussLogo size={40} color="#ffffff" />
        <span>Checking admin access...</span>
      </div>
    );
  }

  if (access === "denied") {
    return (
      <div
        className="admin-scope"
        style={{
          height: "100vh",
          width: "100vw",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          backgroundColor: "var(--bg-app)",
          color: "var(--text-secondary)",
          textAlign: "center",
          padding: "24px",
        }}
      >
        <NexussLogo size={40} color="#ffffff" />
        <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--text-primary)" }}>
          403 — Admin access required
        </h1>
        <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", maxWidth: "420px" }}>
          Your account is not authorized to access the Nexuss Admin panel.
        </p>
        <Link
          href="/"
          style={{ marginTop: "8px", fontSize: "0.9rem", color: "var(--accent-primary)", textDecoration: "underline" }}
        >
          Back to the app
        </Link>
      </div>
    );
  }

  return (
    <div className="admin-scope">
      <AdminLayout>{children}</AdminLayout>
    </div>
  );
}
