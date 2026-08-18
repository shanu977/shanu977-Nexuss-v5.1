import { type ProviderType } from "./providers";

export interface Chat {
  id: string;
  userId: string;
  title: string;
  provider: ProviderType;
  createdAt: number;
  updatedAt: number;
}

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  chatId: string;
  role: Exclude<Role, "system">;
  content: string;
  timestamp: number;
}

export interface AIMessage {
  role: Role;
  content: string;
}

export interface Settings {
  selectedProvider: ProviderType;
}

export interface ChatState {
  currentChat: Chat | null;
  chats: Chat[];
  messages: Message[];
  provider: ProviderType;
  model: string;
  loading: boolean;
  error: string | null;
  isStreaming: boolean;
  // Id of the assistant message currently being streamed (added to `messages`
  // as soon as the first chunk arrives and updated in place until completion).
  streamingMessageId: string | null;
  fallbackNotice: string | null;
}
