"use client";

import { useEffect, useState } from "react";
import AuthProvider from "@/components/AuthProvider";
import AuthView from "@/components/AuthView";
import Hydrate from "@/components/Hydrate";
import Sidebar from "@/components/Sidebar";
import ChatPage from "@/components/ChatPage";
import LandingPage from "@/components/landing/LandingPage";
import { useAuthStore } from "@/store/useAuthStore";

function MainApp() {
  const { user } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<"landing" | "auth">("landing");

  // Default the sidebar to open on desktop, closed on tablet/mobile.
  useEffect(() => {
    setSidebarOpen(window.innerWidth >= 1024);
  }, []);

  if (!user) {
    if (view === "landing") {
      return <LandingPage onNavigateAuth={() => setView("auth")} />;
    }
    return <AuthView onBack={() => setView("landing")} />;
  }

  return (
    <Hydrate>
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
    </Hydrate>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
