"use client";

import { useCallback } from "react";
import MessageList from "@/components/MessageList";
import ChatComposer from "@/components/ChatComposer";
import ChatHeader from "@/components/ChatHeader";
import ScreenSharePanel from "@/components/ScreenSharePanel";
import WorkspacePanel from "@/components/WorkspacePanel";
import { useChat } from "@/hooks/useChat";
import { useScreenShare } from "@/hooks/useScreenShare";
import { useWorkspaceStore } from "@/workspace/store";

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
    streamingMessageId,
    error,
    sendMessageStream,
    stopGeneration,
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

  const workspacePanelOpen = useWorkspaceStore((s) => s.panelOpen);
  const openWorkspacePanel = () => useWorkspaceStore.getState().togglePanel();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground font-sans transition-colors duration-200 w-full dark:bg-[#0f0f0f]">
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
          streamingMessageId={streamingMessageId}
          onSendSuggestion={handleSend}
          screenShareActive={screenShareActive}
          captureScreenFrame={captureFrame}
        />
        {showScreenSharePanel && <ScreenSharePanel screenShare={screenShare} />}
        {workspacePanelOpen && <WorkspacePanel />}
        <ChatComposer
          onSend={handleSend}
          onStop={stopGeneration}
          loading={loading}
          disabled={isStreaming}
          onStartScreenShare={() => void screenShare.startSharing()}
          onOpenWorkspace={openWorkspacePanel}
        />
      </main>
    </div>
  );
}
