import { useChatStore } from "@/store";

export function useChat() {
  const currentChat = useChatStore((s) => s.currentChat);
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const error = useChatStore((s) => s.error);
  const sendMessageStream = useChatStore((s) => s.sendMessageStream);
  const editMessageAndRegenerate = useChatStore((s) => s.editMessageAndRegenerate);
  const regenerateResponse = useChatStore((s) => s.regenerateResponse);
  const createNewChat = useChatStore((s) => s.createNewChat);
  const clearError = useChatStore((s) => s.clearError);
  const theme = useChatStore((s) => s.theme);
  const setTheme = useChatStore((s) => s.setTheme);
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);

  return {
    currentChat,
    messages,
    loading,
    isStreaming,
    streamingMessage,
    error,
    theme,
    setTheme,
    provider,
    model,
    setProvider,
    setModel,
    sendMessageStream,
    editMessageAndRegenerate,
    regenerateResponse,
    createNewChat,
    clearError
  };
}
