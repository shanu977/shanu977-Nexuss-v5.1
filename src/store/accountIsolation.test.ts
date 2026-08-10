import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { useUsageStore } from "@/store/usageStore";
import { ApiError } from "@/services/api";
import {
  getLastChatId,
  setLastChatId,
  setLocalTheme,
  getLocalProvider
} from "@/storage/localStorage";
import { Chat, Message } from "@/types/chats";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const current = { uid: null as string | null };
  return {
    authStoreMock: {
      useAuthStore: {
        getState: () => ({ user: current.uid ? { uid: current.uid } : null }),
        setState: () => {}
      }
    },
    setMockUser: (uid: string | null) => {
      current.uid = uid;
    }
  };
});

vi.mock("@/store/useAuthStore", () => mocks.authStoreMock);

vi.mock("@/services/chat", () => ({
  chatService: { send: vi.fn() }
}));

vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue({})
  }
}));

import { chatService } from "@/services/chat";

const UID_A = "user-a";
const UID_B = "user-b";
const setMockUser = mocks.setMockUser;

function makeChat(id: string, title: string, userId: string = UID_A): Chat {
  return { id, userId, title, provider: "groq", createdAt: 1, updatedAt: 1 };
}

function makeMessage(id: string, chatId: string, role: "user" | "assistant", content: string): Message {
  return { id, chatId, role, content, timestamp: 1 };
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, db.usageRecords, async () => {
    await db.chats.clear();
    await db.messages.clear();
    await db.usageRecords.clear();
  });
  setMockUser(UID_A);
  useChatStore.setState({
    currentChat: null,
    chats: [],
    messages: [],
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    loading: false,
    error: null,
    isStreaming: false,
    streamingMessage: "",
    fallbackNotice: null,
    theme: "light"
  });
});

describe("local chat persistence", () => {
  it("keeps device-local chats and re-hydrates them for the same user", async () => {
    await db.chats.bulkAdd([makeChat("chat-a", "A chat")]);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-a", "user", "A secret"),
      makeMessage("m2", "chat-a", "assistant", "A reply")
    ]);
    setLastChatId(UID_A, "chat-a");
    setLocalTheme("dark");
    useChatStore.setState({
      chats: [makeChat("chat-a", "A chat")],
      currentChat: makeChat("chat-a", "A chat"),
      messages: [
        makeMessage("m1", "chat-a", "user", "A secret"),
        makeMessage("m2", "chat-a", "assistant", "A reply")
      ],
      theme: "dark"
    });

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-a"]);
    expect(cs.currentChat?.id).toBe("chat-a");
    expect(cs.messages.map((m) => m.content)).toEqual(["A secret", "A reply"]);
    expect(cs.theme).toBe("dark");
    expect(getLastChatId(UID_A)).toBe("chat-a");
  });

  it("restores last chat, theme and provider from device storage on refresh", async () => {
    await db.chats.bulkAdd([
      makeChat("chat-1", "Old"),
      makeChat("chat-2", "Recent")
    ]);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-2", "user", "hello"),
      makeMessage("m2", "chat-2", "assistant", "hi")
    ]);
    setLastChatId(UID_A, "chat-2");
    setLocalTheme("dark");
    window.localStorage.setItem("provider", JSON.stringify("gemini"));
    window.localStorage.setItem("model", JSON.stringify("gemini-3.6-flash"));

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.currentChat?.id).toBe("chat-2");
    expect(cs.messages.map((m) => m.content)).toEqual(["hello", "hi"]);
    expect(cs.theme).toBe("dark");
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-3.6-flash");
  });

  it("clamps a stale stored model to a valid one for its provider on refresh", async () => {
    setLocalTheme("dark");
    // A model that no longer exists for the provider (e.g. removed from the
    // allowed list) must never be kept, only defaulted for the provider.
    window.localStorage.setItem("provider", JSON.stringify("gemini"));
    window.localStorage.setItem("model", JSON.stringify("gemini-2.5-flash"));

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-3.6-flash");
  });

  it("never keeps an invalid provider stored on refresh", async () => {
    window.localStorage.setItem("provider", JSON.stringify("bogus"));
    window.localStorage.setItem("model", JSON.stringify("gemini-3.6-flash"));

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.provider).toBe("groq");
    expect(cs.model).toBe("llama-3.3-70b-versatile");
  });
});

describe("account isolation", () => {
  it("A creates a chat; B cannot see it", async () => {
    setMockUser(UID_A);
    await useChatStore.getState().createNewChat();

    setMockUser(UID_B);
    useChatStore.setState({
      currentChat: null,
      chats: [],
      messages: []
    });
    await useChatStore.getState().hydrate();

    expect(useChatStore.getState().chats).toHaveLength(0);
  });

  it("B cannot load A's messages", async () => {
    const chat = makeChat("chat-a", "A chat");
    await db.chats.add(chat);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-a", "user", "A secret")
    ]);

    setMockUser(UID_B);
    useChatStore.setState({
      chats: [],
      currentChat: null,
      messages: []
    });

    await useChatStore.getState().loadChat("chat-a");

    const cs = useChatStore.getState();
    expect(cs.currentChat).toBeNull();
    expect(cs.messages).toHaveLength(0);
  });

  it("B cannot delete A's chat", async () => {
    const chat = makeChat("chat-a", "A chat");
    await db.chats.add(chat);
    await db.messages.bulkAdd([makeMessage("m1", "chat-a", "user", "A secret")]);

    setMockUser(UID_B);
    useChatStore.setState({ chats: [], currentChat: null, messages: [] });

    await useChatStore.getState().deleteChat("chat-a");

    const stored = await db.chats.get("chat-a");
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("A chat");
    const msgs = await db.messages.where("chatId").equals("chat-a").toArray();
    expect(msgs).toHaveLength(1);
  });

  it("B cannot search A's chat", async () => {
    await db.chats.add(makeChat("chat-a", "A secret title"));
    await db.chats.add(makeChat("chat-b", "B visible title", UID_B));

    setMockUser(UID_B);
    useChatStore.setState({ chats: [makeChat("chat-b", "B visible title", UID_B)] });

    const results = await useChatStore.getState().searchChats("secret");
    expect(results).toHaveLength(0);

    const all = await useChatStore.getState().searchChats("");
    expect(all.map((c) => c.id)).toEqual(["chat-b"]);
  });

  it("A sees A's chats after logout/login", async () => {
    await db.chats.add(makeChat("chat-a", "A chat"));

    setMockUser(UID_A);
    useChatStore.getState().reset(true);
    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-a"]);
    expect(getLastChatId(UID_A)).toBeNull();
  });

  it("B sees only B's chats after refresh", async () => {
    await db.chats.bulkAdd([
      makeChat("chat-a", "A chat"),
      makeChat("chat-b", "B chat", UID_B)
    ]);
    setMockUser(UID_B);
    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-b"]);
  });

  it("account switching cannot leak the previous user's state", async () => {
    setMockUser(UID_A);
    await useChatStore.getState().createNewChat();
    const aChatId = useChatStore.getState().currentChat!.id;

    setMockUser(UID_B);
    useChatStore.getState().reset(true);
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().chats).toHaveLength(0);

    await useChatStore.getState().createNewChat();
    const bChatId = useChatStore.getState().currentChat!.id;
    expect(bChatId).not.toBe(aChatId);

    setMockUser(UID_A);
    useChatStore.getState().reset(true);
    await useChatStore.getState().hydrate();
    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual([aChatId]);
    expect(cs.chats.some((c) => c.id === bChatId)).toBe(false);
  });

  it("unauthenticated users cannot hydrate chats", async () => {
    await db.chats.add(makeChat("chat-a", "A chat"));
    setMockUser(null);
    useChatStore.setState({ chats: [makeChat("chat-a", "A chat")] });

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.chats).toHaveLength(0);
    expect(cs.currentChat).toBeNull();
    expect(cs.messages).toHaveLength(0);
  });

  it("sendMessageStream never uses a chat owned by another user as context", async () => {
    const foreign = makeChat("chat-foreign", "A chat");
    await db.chats.add(foreign);
    await db.messages.bulkAdd([
      makeMessage("f1", "chat-foreign", "user", "A secret context"),
      makeMessage("f2", "chat-foreign", "assistant", "A secret reply")
    ]);
    // Simulate a leaked in-memory currentChat pointing at A's chat while B is
    // signed in.
    setMockUser(UID_B);
    useChatStore.setState({
      currentChat: foreign,
      messages: [
        makeMessage("f1", "chat-foreign", "user", "A secret context"),
        makeMessage("f2", "chat-foreign", "assistant", "A secret reply")
      ]
    });
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Hello back!",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });

    await useChatStore.getState().sendMessageStream("Hello there");

    // The foreign chat must not have been reused nor its content sent.
    const bChat = useChatStore.getState().currentChat!;
    expect(bChat.id).not.toBe("chat-foreign");
    expect(bChat.userId).toBe(UID_B);
    expect(chatService.send).toHaveBeenCalledWith(
      expect.objectContaining({ history: [] })
    );
  });
});

describe("sendMessageStream", () => {
  it("creates a chat, sends history, and persists the assistant reply locally", async () => {
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Hello back!",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });

    await useChatStore.getState().sendMessageStream("Hello there");

    const cs = useChatStore.getState();
    expect(cs.chats).toHaveLength(1);
    expect(cs.chats[0].userId).toBe(UID_A);
    expect(cs.currentChat?.id).toBe(cs.chats[0].id);
    expect(cs.messages.map((m) => m.content)).toEqual(["Hello there", "Hello back!"]);
    expect(cs.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(cs.chats[0].title).toBe("Hello there");
    expect(cs.loading).toBe(false);
    expect(cs.error).toBeNull();

    expect(chatService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Hello there",
        history: [],
        provider: "groq",
        model: "llama-3.3-70b-versatile"
      })
    );

    const storedMessages = await db.messages
      .where("chatId")
      .equals(cs.chats[0].id)
      .sortBy("timestamp");
    expect(storedMessages.map((m) => m.content).sort()).toEqual(
      ["Hello there", "Hello back!"].sort()
    );
    expect(getLastChatId(UID_A)).toBe(cs.chats[0].id);
  });

  it("persists a follow-up with the prior turns in history", async () => {
    const chat = makeChat("chat-1", "Existing");
    await db.chats.add(chat);
    useChatStore.setState({
      chats: [chat],
      currentChat: chat,
      messages: [
        makeMessage("m1", "chat-1", "user", "First"),
        makeMessage("m2", "chat-1", "assistant", "Second")
      ]
    });
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Third reply",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });

    await useChatStore.getState().sendMessageStream("Third");

    expect(chatService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Third",
        history: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Second" }
        ],
        provider: "groq"
      })
    );

    const cs = useChatStore.getState();
    expect(cs.messages.map((m) => m.content)).toEqual(["First", "Second", "Third", "Third reply"]);
    expect(cs.chats[0].title).toBe("Existing");
  });

  it("surfaces errors from the chat API without losing the user message", async () => {
    vi.mocked(chatService.send).mockRejectedValue(new Error("Bad gateway"));

    await useChatStore.getState().sendMessageStream("Hello");

    const cs = useChatStore.getState();
    expect(cs.error).toBe("Bad gateway");
    expect(cs.loading).toBe(false);
    expect(cs.messages.map((m) => m.content)).toEqual(["Hello"]);
    expect(getLocalProvider()).toBe("groq");
  });

  it("never stores API keys in localStorage or IndexedDB", async () => {
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Hello back!",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });

    await useChatStore.getState().sendMessageStream("Hello");

    // Nothing sent to the backend looks like a key, and nothing local does.
    expect(chatService.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ api_key: expect.anything() })
    );
    const allLocal = JSON.stringify({
      localStorage: window.localStorage,
      chats: await db.chats.toArray(),
      messages: await db.messages.toArray()
    });
    expect(allLocal).not.toContain("sk-");
    expect(allLocal).not.toContain("api_key");
  });
});

describe("provider/model selection", () => {
  it("setProvider resets the model to that provider's default", () => {
    useChatStore.getState().setProvider("gemini");
    const cs = useChatStore.getState();
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-3.6-flash");
    expect(getLocalProvider()).toBe("gemini");
  });

  it("setModel keeps the exact model selected for its provider", () => {
    useChatStore.getState().setProvider("gemini");
    useChatStore.getState().setModel("gemini-2.5-pro");
    const cs = useChatStore.getState();
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-2.5-pro");
  });

  it("setModel rejects a model that belongs to another provider", () => {
    useChatStore.getState().setProvider("groq");
    useChatStore.getState().setModel("gemini-3.6-flash");
    const cs = useChatStore.getState();
    expect(cs.provider).toBe("groq");
    expect(cs.model).toBe("llama-3.3-70b-versatile");
  });

  it("sendMessageStream sends the exact selected model to the backend", async () => {
    useChatStore.getState().setProvider("gemini");
    useChatStore.getState().setModel("gemini-2.5-pro");
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Hello back!",
      provider: "gemini",
      model: "gemini-2.5-pro"
    });

    await useChatStore.getState().sendMessageStream("Hello");

    expect(chatService.send).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini", model: "gemini-2.5-pro" })
    );
    const cs = useChatStore.getState();
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-2.5-pro");
  });
});

describe("fallback usage tracking", () => {
  it("records every attempt and echoes the actual fallback provider/model", async () => {
    vi.mocked(chatService.send).mockResolvedValue({
      reply: "Hello from OpenRouter!",
      provider: "openrouter",
      model: "openai/gpt-oss-120b:free",
      usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
      fallback_used:
        "Groq was temporarily unavailable. Response generated using Openrouter.",
      attempts: [
        {
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          attempt: 1,
          status: "failed",
          http_status: 429,
          reason: "rate_limit",
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          response_time_ms: 42,
          timestamp: 1
        },
        {
          provider: "openrouter",
          model: "openai/gpt-oss-120b:free",
          attempt: 2,
          status: "success",
          http_status: 200,
          reason: null,
          input_tokens: 3,
          output_tokens: 7,
          total_tokens: 10,
          response_time_ms: 120,
          timestamp: 2
        }
      ]
    });

    await useChatStore.getState().sendMessageStream("Hello");

    // The store echoes the actual provider/model that generated the reply.
    const cs = useChatStore.getState();
    expect(cs.provider).toBe("openrouter");
    expect(cs.model).toBe("openai/gpt-oss-120b:free");
    expect(cs.fallbackNotice).toBe(
      "Groq was temporarily unavailable. Response generated using Openrouter."
    );

    // Every attempt is recorded: the failed primary (0 tokens) and the
    // successful fallback (with its real usage).
    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(2);
    const byProvider = Object.fromEntries(
      records.map((r) => [r.provider, r])
    );
    expect(byProvider["groq"].success).toBe(false);
    expect(byProvider["groq"].totalTokens).toBe(0);
    expect(byProvider["openrouter"].success).toBe(true);
    expect(byProvider["openrouter"].totalTokens).toBe(10);
    expect(byProvider["openrouter"].model).toBe("openai/gpt-oss-120b:free");
  });

  it("records error attempts when every provider fails", async () => {
    const failedAttempts = [
      {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        attempt: 1,
        status: "failed",
        http_status: 429,
        reason: "rate_limit",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        response_time_ms: 10,
        timestamp: 1
      },
      {
        provider: "openrouter",
        model: "openai/gpt-oss-120b:free",
        attempt: 2,
        status: "failed",
        http_status: 503,
        reason: "provider_unavailable",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        response_time_ms: 11,
        timestamp: 2
      }
    ];
    vi.mocked(chatService.send).mockRejectedValue(
      new ApiError(502, "All AI providers failed.", failedAttempts)
    );

    await useChatStore.getState().sendMessageStream("Hello");

    const cs = useChatStore.getState();
    expect(cs.error).toBe("All AI providers failed.");
    expect(cs.fallbackNotice).toBeNull();

    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.success === false)).toBe(true);
    expect(records.map((r) => r.provider).sort()).toEqual(["groq", "openrouter"]);
  });

  it("clears the fallback notice when the primary succeeds next time", async () => {
    vi.mocked(chatService.send).mockResolvedValueOnce({
      reply: "Fallen back",
      provider: "openrouter",
      model: "openai/gpt-oss-120b:free",
      fallback_used:
        "Groq was temporarily unavailable. Response generated using Openrouter.",
      attempts: [
        {
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          attempt: 1,
          status: "failed",
          http_status: 429,
          reason: "rate_limit",
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          response_time_ms: 5,
          timestamp: 1
        },
        {
          provider: "openrouter",
          model: "openai/gpt-oss-120b:free",
          attempt: 2,
          status: "success",
          http_status: 200,
          reason: null,
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          response_time_ms: 6,
          timestamp: 2
        }
      ]
    });
    vi.mocked(chatService.send).mockResolvedValueOnce({
      reply: "Primary back",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });

    await useChatStore.getState().sendMessageStream("First");
    expect(useChatStore.getState().fallbackNotice).toContain("Groq");

    await useChatStore.getState().sendMessageStream("Second");
    expect(useChatStore.getState().fallbackNotice).toBeNull();
  });
});
