"use client";

import { useCallback } from "react";
import MessageList from "@/components/MessageList";
import ChatComposer from "@/components/ChatComposer";
import ChatHeader from "@/components/ChatHeader";
import ScreenSharePanel from "@/components/ScreenSharePanel";
import { useChat } from "@/hooks/useChat";
import { useScreenShare } from "@/hooks/useScreenShare";

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

  const screenShare = useScreenShare();
  const { isActive: screenShareActive, error: screenShareError, captureFrame } =
    screenShare;

  const handleSidebarToggle = onToggleSidebar || onOpenSidebar || (() => {});

  // While screen sharing is active, capture exactly ONE fresh frame from the
  // live preview and attach it to this request only. The live stream itself is
  // never sent anywhere. If the frame is not ready yet, fall back to a normal
  // text request rather than blocking the chat.
  const handleSend = useCallback(
    async (content: string) => {
      const image = screenShareActive ? captureFrame() ?? undefined : undefined;
      await sendMessageStream(content, image);
    },
    [screenShareActive, captureFrame, sendMessageStream]
  );

  const showScreenSharePanel = screenShareActive || !!screenShareError;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground font-sans transition-colors duration-200 w-full">
      <ChatHeader
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleSidebarToggle}
      />

      <main className="relative flex min-h-0 flex-1 flex-col">
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
          onSendSuggestion={handleSend}
        />
        {showScreenSharePanel && <ScreenSharePanel screenShare={screenShare} />}
        <ChatComposer
          onSend={handleSend}
          loading={loading}
          disabled={isStreaming}
          onStartScreenShare={() => void screenShare.startSharing()}
        />
      </main>
    </div>
  );
}
