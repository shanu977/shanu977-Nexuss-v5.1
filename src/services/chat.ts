import { request, requestStream } from "./api";
import { ChatResponse, FallbackAttempt, UsageInfo } from "@/types/chat";
import { ProviderType } from "@/types";

export interface ChatSendBody {
  message: string;
  history: { role: string; content: string }[];
  provider: ProviderType;
  model: string;
  // Optional single screen frame (base64 data URL) for screen-share
  // analysis. Transient: processed server-side, never stored.
  image?: string;
  // Optional client-selected workspace context (the most relevant local
  // files/sections for THIS question, picked by the Path workspace engine).
  // Attached to the prompt server-side as a separate note; chat history stays
  // separate and the full project is never sent.
  workspaceContext?: string;
}

/** SSE event: one content delta of the assistant reply. */
export interface ChatStreamChunkEvent {
  type: "chunk";
  content: string;
}

/** SSE event: the answer completed successfully, with usage/fallback details. */
export interface ChatStreamUsageEvent {
  type: "usage";
  usage: UsageInfo;
  provider: string;
  model: string;
  fallback_used: string | null;
  attempts: FallbackAttempt[];
}

/**
 * SSE event: a provider failure. `partial` is true when some content was
 * already streamed before the failure (keep it; a regenerated answer would be
 * disjoint). `attempts` carries the attempt log for usage recording.
 */
export interface ChatStreamErrorEvent {
  type: "error";
  status: number;
  message: string;
  attempts: FallbackAttempt[];
  partial: boolean;
}

export type ChatStreamEvent =
  | ChatStreamChunkEvent
  | ChatStreamUsageEvent
  | ChatStreamErrorEvent;

export const chatService = {
  send: (body: ChatSendBody) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  /** Stream the assistant answer as Server-Sent Events (`chunk`/`usage`/`error`). */
  sendStream: (
    body: ChatSendBody,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<ChatStreamEvent> =>
    requestStream<ChatStreamEvent>("/chat/stream", {
      method: "POST",
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {})
    })
};
