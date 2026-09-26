"use client";

import { useChatStore } from "@/store";
import { PanelLeftIcon } from "@/components/icons";
import { NexussLogo } from "@/components/admin/NexussLogo";

interface ChatHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function ChatHeader({
  sidebarOpen,
  onToggleSidebar
}: ChatHeaderProps) {
  const currentChat = useChatStore((s) => s.currentChat);

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {/* Sidebar Toggle Button */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          <PanelLeftIcon className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <NexussLogo size={22} color="currentColor" className="text-foreground shrink-0" />
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
              NEXUSS AI
            </span>
            <span className="text-[11px] font-mono text-muted-foreground">•</span>
            <span className="truncate text-xs font-semibold text-foreground">
              {currentChat?.title || "New conversation"}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
