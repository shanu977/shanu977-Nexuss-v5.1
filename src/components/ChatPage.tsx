"use client";

import MessageList from "@/components/MessageList";
import ChatInput from "@/components/ChatInput";
import { useChat } from "@/hooks/useChat";
import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { getModelLabel, type ProviderType } from "@/types/providers";

interface ChatPageProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onOpenSidebar?: () => void;
}

export default function ChatPage({
  sidebarOpen = false,
  onToggleSidebar,
  onOpenSidebar,
}: ChatPageProps) {
  const {
    messages,
    loading,
    isStreaming,
    streamingMessage,
    error,
    sendMessageStream,
    clearError
  } = useChat();
  const currentChat = useChatStore((s) => s.currentChat);
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);

  const handleSidebarToggle = onToggleSidebar || onOpenSidebar;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground font-sans transition-colors duration-200 w-full">
      {/* Polished Chat Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3 shadow-xs">
        <div className="flex items-center gap-3 min-w-0">
          {/* Sidebar Toggle Button */}
          <button
            type="button"
            onClick={handleSidebarToggle}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-xs font-semibold text-foreground hover:bg-muted transition-colors cursor-pointer shadow-2xs"
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            ☰
          </button>

          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest">
                NEXUSS AI
              </span>
              <span className="text-muted-foreground font-mono text-[11px]">•</span>
              <span className="truncate text-xs font-semibold text-foreground">
                {currentChat?.title || "New conversation"}
              </span>
            </div>
          </div>
        </div>

        {/* Right side status & active model pill */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>Online</span>
          </div>
          <div className="rounded-lg border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground font-medium">
            {PROVIDER_LABELS[provider]} • {getModelLabel(provider as ProviderType, model)}
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col relative">
        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-mono text-destructive"
          >
            <span aria-hidden="true">⚠</span>
            <span className="flex-1">{error}</span>
            <button
              onClick={clearError}
              className="shrink-0 rounded bg-destructive/20 px-2 py-0.5 text-[11px] font-medium hover:bg-destructive/30"
            >
              Dismiss
            </button>
          </div>
        )}
        <MessageList
          messages={messages}
          loading={loading}
          isStreaming={isStreaming}
          streamingMessage={streamingMessage}
          onSendSuggestion={sendMessageStream}
        />
        <ChatInput
          onSend={sendMessageStream}
          loading={loading}
          disabled={isStreaming}
        />
      </main>
    </div>
  );
}
