import { useChatStore } from "@/store";

export function useChat() {
  const currentChat = useChatStore((s) => s.currentChat);
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const error = useChatStore((s) => s.error);
  const errorRetryable = useChatStore((s) => s.errorRetryable ?? false);
  const sendMessageStream = useChatStore((s) => s.sendMessageStream);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const editMessageAndRegenerate = useChatStore((s) => s.editMessageAndRegenerate);
  const regenerateResponse = useChatStore((s) => s.regenerateResponse);
  const retryLastMessage = useChatStore((s) => s.retryLastMessage);
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
    streamingMessageId,
    error,
    errorRetryable,
    theme,
    setTheme,
    provider,
    model,
    setProvider,
    setModel,
    sendMessageStream,
    stopGeneration,
    editMessageAndRegenerate,
    regenerateResponse,
    retryLastMessage,
    createNewChat,
    clearError
  };
}
