import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, EMPTY_REPLY_FALLBACK } from "@/store/chatStore";
import { useUsageStore } from "@/store/usageStore";
import { chatService, ChatStreamEvent } from "@/services/chat";
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
  chatService: { sendStream: vi.fn() }
}));

vi.mock("@/services/settings", () => ({
  settingsService: { get: vi.fn(), update: vi.fn() }
}));

const UID = "user-a";
const setMockUser = mocks.setMockUser;
const sendStreamMock = vi.mocked(chatService.sendStream);

// A controllable stream: each step is gated until `next()` is called, letting
// the test observe the store state BETWEEN chunks (in-place message updates,
// streamingMessageId, isStreaming).
function stepStream(steps: (() => ChatStreamEvent)[]): {
  gen: AsyncGenerator<ChatStreamEvent>;
  next: () => void;
} {
  const releases: (() => void)[] = [];
  const gates: Promise<void>[] = [];
  for (let i = 0; i < steps.length; i++) {
    gates.push(
      new Promise<void>((resolve) => {
        releases.push(resolve);
      })
    );
  }
  async function* gen() {
    for (let i = 0; i < steps.length; i++) {
      await gates[i];
      yield steps[i]() as ChatStreamEvent;
    }
  }
  let cursor = 0;
  return { gen: gen(), next: () => releases[cursor++]?.() };
}

function usageEvent(
  overrides: Partial<Extract<ChatStreamEvent, { type: "usage" }>> = {}
): Extract<ChatStreamEvent, { type: "usage" }> {
  return {
    type: "usage",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    fallback_used: null,
    attempts: [],
    ...overrides
  };
}

function makeChat(id: string, title: string): Chat {
  return { id, userId: UID, title, provider: "groq", createdAt: 1, updatedAt: 1 };
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, db.usageRecords, async () => {
    await db.chats.clear();
    await db.messages.clear();
    await db.usageRecords.clear();
  });
  setMockUser(UID);
  useChatStore.setState({
    currentChat: null,
    chats: [],
    messages: [],
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    loading: false,
    error: null,
    isStreaming: false,
    streamingMessageId: null,
    fallbackNotice: null,
    theme: "light"
  });
  sendStreamMock.mockReset();
});

function lastMessage(): Message {
  const messages = useChatStore.getState().messages;
  return messages[messages.length - 1];
}

describe("chat streaming", () => {
  it("grows a single in-place assistant message and tracks streamingMessageId", async () => {
    const chat = makeChat("chat-s", "Stream chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    const step = stepStream([
      () => ({ type: "chunk", content: "Hello" }),
      () => ({ type: "chunk", content: " world" }),
      () => usageEvent()
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore.getState().sendMessageStream("Hi");

    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    const asstId = useChatStore.getState().streamingMessageId!;
    expect(useChatStore.getState().isStreaming).toBe(true);

    // The streaming assistant message is created immediately with empty
    // content; the first visible chunk fills it in place.
    const assistantMsgs = useChatStore
      .getState()
      .messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content).toBe("");

    step.next();
    await vi.waitFor(() => expect(lastMessage().content).toBe("Hello"));
    expect(lastMessage().id).toBe(asstId);
    expect(lastMessage().role).toBe("assistant");
    expect(useChatStore.getState().messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    step.next();
    await vi.waitFor(() => expect(lastMessage().content).toBe("Hello world"));
    expect(useChatStore.getState().messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    step.next();
    await pending;

    const cs = useChatStore.getState();
    expect(cs.isStreaming).toBe(false);
    expect(cs.streamingMessageId).toBeNull();
    expect(cs.loading).toBe(false);
    expect(cs.error).toBeNull();

    // The completed message is persisted with the final text only.
    const stored = await db.messages.get(asstId);
    expect(stored?.content).toBe("Hello world");
  });

  it("strips reasoning even when the markers are split across chunks", async () => {
    const chat = makeChat("chat-r", "Reasoning");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    const step = stepStream([
      () => ({ type: "chunk", content: " thinki" }),
      () => ({ type: "chunk", content: "ng\ninternal reasoning only\n respo" }),
      () => ({ type: "chunk", content: "nse\nThe fix is to install pandas." }),
      () => usageEvent()
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore.getState().sendMessageStream("Why does this fail?");

    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    step.next();
    // The first two chunks are still inside the reasoning block: the streaming
    // assistant message exists but stays empty (no visible content yet).
    step.next();
    await vi.waitFor(() => {
      const assistants = useChatStore
        .getState()
        .messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0].content).toBe("");
    });
    step.next();
    await vi.waitFor(() => expect(lastMessage().content).toBe("The fix is to install pandas."));
    step.next();
    await pending;

    expect(lastMessage().content).toBe("The fix is to install pandas.");
    expect(lastMessage().content).not.toContain("thinking");
    expect(lastMessage().content).not.toContain("internal reasoning");
  });

  it("keeps partial text and surfaces the error when the stream fails mid-answer", async () => {
    const chat = makeChat("chat-e", "Error chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    const attempts = [
      {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        attempt: 1,
        status: "failed" as const,
        http_status: 503,
        reason: "provider_unavailable",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        response_time_ms: 12,
        timestamp: 1
      }
    ];
    const step = stepStream([
      () => ({ type: "chunk", content: "Partial answer" }),
      () => ({ type: "error", status: 502, message: "Connection lost.", partial: true, attempts })
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore.getState().sendMessageStream("Hello");

    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    step.next();
    await vi.waitFor(() => expect(lastMessage().content).toBe("Partial answer"));
    step.next();
    await pending;

    const cs = useChatStore.getState();
    expect(cs.error).toBe("Connection lost.");
    expect(cs.isStreaming).toBe(false);
    expect(cs.streamingMessageId).toBeNull();
    // The partial text stays on screen and is persisted.
    expect(cs.messages.map((m) => m.content)).toEqual(["Hello", "Partial answer"]);
    const stored = await db.messages
      .where("chatId")
      .equals("chat-e")
      .sortBy("timestamp");
    expect(stored.map((m) => m.content)).toEqual(["Hello", "Partial answer"]);

    // The failed attempt was recorded for usage tracking.
    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
    expect(records[0].provider).toBe("groq");
  });

  it("uses the empty-reply fallback when the stream yields only reasoning", async () => {
    const chat = makeChat("chat-f", "Fallback chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    const step = stepStream([
      () => ({ type: "chunk", content: " thinking\nonly internal reasoning here\n response\n" }),
      () => usageEvent()
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore.getState().sendMessageStream("first question");
    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    step.next();
    step.next();
    await pending;

    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(lastMessage().role).toBe("assistant");
    expect(lastMessage().content).toBe(EMPTY_REPLY_FALLBACK);
  });

  it("records every attempt from the usage event and echoes the fallback provider/model", async () => {
    const chat = makeChat("chat-u", "Usage chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    const step = stepStream([
      () => ({ type: "chunk", content: "Answered via fallback" }),
      () =>
        usageEvent({
          provider: "openrouter",
          model: "openai/gpt-oss-120b:free",
          fallback_used: "Groq was temporarily unavailable. Response generated using Openrouter.",
          attempts: [
            {
              provider: "groq",
              model: "llama-3.3-70b-versatile",
              attempt: 1,
              status: "failed" as const,
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
              status: "success" as const,
              http_status: 200,
              reason: null,
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              response_time_ms: 120,
              timestamp: 2
            }
          ]
        })
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore.getState().sendMessageStream("Hello");
    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    step.next();
    step.next();
    await pending;

    const cs = useChatStore.getState();
    expect(cs.provider).toBe("openrouter");
    expect(cs.model).toBe("openai/gpt-oss-120b:free");
    expect(cs.fallbackNotice).toBe(
      "Groq was temporarily unavailable. Response generated using Openrouter."
    );

    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(2);
    const byProvider = Object.fromEntries(records.map((r) => [r.provider, r]));
    expect(byProvider["groq"].success).toBe(false);
    expect(byProvider["openrouter"].success).toBe(true);
    expect(byProvider["openrouter"].totalTokens).toBe(15);
  });

  it("does not overwrite the user's provider/model selection for screen-share requests", async () => {
    const chat = makeChat("chat-ss", "Screen chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    // The backend answers a screen-share request with a server-side vision
    // model, but the user's selection must stay untouched.
    const step = stepStream([
      () => ({ type: "chunk", content: "I see an error in the frame." }),
      () => usageEvent({ provider: "openrouter", model: "qwen/qwen3.6-27b" })
    ]);
    sendStreamMock.mockReturnValueOnce(step.gen);

    const pending = useChatStore
      .getState()
      .sendMessageStream("What is this error?", "data:image/jpeg;base64,FRAME");
    await vi.waitFor(() =>
      expect(useChatStore.getState().streamingMessageId).not.toBeNull()
    );
    step.next();
    step.next();
    await pending;

    const cs = useChatStore.getState();
    expect(cs.provider).toBe("groq");
    expect(cs.model).toBe("llama-3.3-70b-versatile");
  });

  it("surfaces a thrown stream error without losing the user message", async () => {
    const chat = makeChat("chat-t", "Throw chat");
    await db.chats.add(chat);
    useChatStore.setState({ currentChat: chat, chats: [chat] });

    async function* thrower() {
      throw new Error("Bad gateway");
    }
    sendStreamMock.mockReturnValueOnce(thrower());

    await useChatStore.getState().sendMessageStream("Hello");

    const cs = useChatStore.getState();
    expect(cs.error).toBe("Bad gateway");
    expect(cs.loading).toBe(false);
    expect(cs.isStreaming).toBe(false);
    expect(cs.streamingMessageId).toBeNull();
    expect(cs.messages.map((m) => m.content)).toEqual(["Hello"]);
  });
});
