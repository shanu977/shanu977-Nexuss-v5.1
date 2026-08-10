import { request } from "./api";
import { ChatResponse } from "@/types/chat";
import { ProviderType } from "@/types";

export const chatService = {
  send: (body: {
    message: string;
    history: { role: string; content: string }[];
    provider: ProviderType;
    model: string;
  }) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(body)
    })
};
