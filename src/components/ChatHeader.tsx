"use client";

import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { getModelLabel, type ProviderType } from "@/types/providers";
import { PanelLeftIcon } from "@/components/icons";

interface ChatHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function ChatHeader({
  sidebarOpen,
  onToggleSidebar
}: ChatHeaderProps) {
  const currentChat = useChatStore((s) => s.currentChat);
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3 shadow-xs">
      <div className="flex min-w-0 items-center gap-3">
        {/* Sidebar Toggle Button */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer shadow-2xs"
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          <PanelLeftIcon className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
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

      {/* Right side status & active model pill */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-muted-foreground sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>Online</span>
        </div>
        <div className="rounded-lg border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono font-medium text-foreground">
          {PROVIDER_LABELS[provider]} • {getModelLabel(provider as ProviderType, model)}
        </div>
      </div>
    </header>
  );
}
