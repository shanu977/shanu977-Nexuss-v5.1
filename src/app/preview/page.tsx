"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import ChatPage from "@/components/ChatPage";
import { useChatStore } from "@/store";

export default function PreviewPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(window.innerWidth >= 1024);
  }, []);

  // Development-only dark-mode preview. Bypasses Firebase auth by rendering
  // the real ChatPage/Sidebar directly (no AuthProvider). Dark mode is forced
  // here after hydration so a persisted "light" theme cannot override it.
  useEffect(() => {
    useChatStore.setState({ theme: "dark" });
    document.documentElement.classList.add("dark");
    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <ChatPage
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />
    </div>
  );
}
