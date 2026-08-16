import { request } from "./api";
import { ChatResponse } from "@/types/chat";
import { ProviderType } from "@/types";

export const chatService = {
  send: (body: {
    message: string;
    history: { role: string; content: string }[];
    provider: ProviderType;
    model: string;
    // Optional single screen frame (base64 data URL) for screen-share
    // analysis. Transient: processed server-side, never stored.
    image?: string;
  }) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(body)
    })
};
