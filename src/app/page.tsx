"use client";

import { useEffect, useState } from "react";
import { AdMeshProvider } from "admesh-ui-sdk";
import AuthProvider from "@/components/AuthProvider";
import AuthView from "@/components/AuthView";
import Hydrate from "@/components/Hydrate";
import Sidebar from "@/components/Sidebar";
import ChatPage from "@/components/ChatPage";
import LandingPage from "@/components/landing/LandingPage";
import { useAuthStore } from "@/store/useAuthStore";
import { setAdMeshProviderMounted } from "@/lib/admesh";

const ADMESH_SESSION_ID_KEY = "admesh_session_id";

function getOrCreateAdMeshSessionId(): string {
  try {
    const existing = window.localStorage.getItem(ADMESH_SESSION_ID_KEY);
    if (existing) return existing;
    const id = window.crypto.randomUUID();
    window.localStorage.setItem(ADMESH_SESSION_ID_KEY, id);
    return id;
  } catch {
    return "";
  }
}

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
  const [adMeshSessionId, setAdMeshSessionId] = useState("");

  useEffect(() => {
    const sessionId = getOrCreateAdMeshSessionId();
    setAdMeshSessionId(sessionId);
    setAdMeshProviderMounted(
      Boolean(process.env.NEXT_PUBLIC_ADMESH_API_KEY && sessionId)
    );
  }, []);

  const adMeshApiKey = process.env.NEXT_PUBLIC_ADMESH_API_KEY;

  const app = (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );

  if (!adMeshApiKey || !adMeshSessionId) {
    return app;
  }

  return (
    <AdMeshProvider apiKey={adMeshApiKey} sessionId={adMeshSessionId}>
      {app}
    </AdMeshProvider>
  );
}
