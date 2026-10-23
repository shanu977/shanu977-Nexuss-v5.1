// Chat-store integration for the automatic Ollama connection flow:
// the pre-flight ensure, the retryable-error flag, and the "Try again"
// action (retryLastMessage) that re-answers the last user message without
// ever duplicating it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { useLocalModelStore } from "@/store/localModelStore";
import { useLocalConnectionStore, finishLocalConnection } from "@/store/localConnectionStore";
import {
  ensureLocalModelConnection,
  streamLocalChat,
  LocalConnectionError,
  LOCAL_CONNECTION_MESSAGES,
} from "@/services/localModels";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const current = { uid: "user-a" };
  return {
    authMock: {
      useAuthStore: {
        getState: () => ({ user: { uid: current.uid } }),
      },
    },
  };
});
vi.mock("@/store/useAuthStore", () => mocks.authMock);
vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue({ provider: "groq", model: "openai/gpt-oss-120b", theme: "light" }),
    update: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("@/services/localModels", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...(orig as object),
    streamLocalChat: vi.fn(),
    ensureLocalModelConnection: vi.fn().mockResolvedValue({ ok: true, via: "skipped", alreadyRunning: true }),
    testLocalEndpoint: vi.fn().mockResolvedValue({
      ok: true,
      message: "ok",
      models: ["llama3.2:3b"],
      endpointReachable: true,
      modelsDiscoverable: true,
    }),
  };
});

function makeStream(chunks: string[]) {
  return (async function* () {
    for (const c of chunks) yield { type: "chunk", content: c } as const;
    yield { type: "done" } as const;
  })();
}

function makeFailingStream(err: Error) {
  return (async function* () {
    throw err;
  })();
}

async function setupOllamaLocalChat() {
  const p = await useLocalModelStore.getState().addProvider({
    name: "Ollama",
    providerType: "ollama",
    endpoint: "http://localhost:11434/v1",
  });
  await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
  useChatStore.getState().setProvider("local");
  useChatStore.getState().setModel("llama3.2:3b");
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, db.usageRecords, db.localProviders, db.localModels, async () => {
    await db.chats.clear();
    await db.messages.clear();
    await db.usageRecords.clear();
    await db.localProviders.clear();
    await db.localModels.clear();
  });
  useChatStore.setState({
    currentChat: null,
    chats: [],
    messages: [],
    provider: "groq",
    model: "openai/gpt-oss-120b",
    loading: false,
    error: null,
    isStreaming: false,
    streamingMessageId: null,
    fallbackNotice: null,
    errorRetryable: false,
    theme: "light",
  });
  useLocalModelStore.setState({ providers: [], models: [], hydrated: false });
  finishLocalConnection();
  vi.clearAllMocks();
  vi.mocked(ensureLocalModelConnection).mockResolvedValue({ ok: true, via: "skipped", alreadyRunning: true });
});

describe("chat store — pre-flight Ollama ensure", () => {
  it("verifies the connection for Ollama loopback providers before streaming", async () => {
    await setupOllamaLocalChat();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hello ", "there!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    expect(ensureLocalModelConnection).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://localhost:11434/v1", providerType: "ollama" })
    );
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["Hi", "Hello there!"]);
    // Card lifecycle settles to idle after the request.
    expect(useLocalConnectionStore.getState().phase).toBe("idle");
  });

  it("does not run the ensure for non-Ollama local providers", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "LM Studio",
      providerType: "lmstudio",
      endpoint: "http://localhost:1234/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "qwen2.5:7b");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("qwen2.5:7b");
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["ok"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    expect(ensureLocalModelConnection).not.toHaveBeenCalled();
  });

  it("surfaces the ensure failure as a retryable connection error with no leftover bubble", async () => {
    await setupOllamaLocalChat();
    vi.mocked(ensureLocalModelConnection).mockResolvedValue({
      ok: false,
      reason: "not_started",
      message: LOCAL_CONNECTION_MESSAGES.not_started,
    });

    await useChatStore.getState().sendMessageStream("Hi");

    const s = useChatStore.getState();
    expect(s.error).toBe(LOCAL_CONNECTION_MESSAGES.not_started);
    expect(s.errorRetryable).toBe(true);
    // The empty assistant placeholder is dropped; only the user message remains.
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([["user", "Hi"]]);
    expect(s.loading).toBe(false);
    // The connection card never lingers after a failure.
    expect(useLocalConnectionStore.getState().phase).toBe("idle");
  });

  it("marks stream-level LocalConnectionErrors retryable too", async () => {
    await setupOllamaLocalChat();
    vi.mocked(streamLocalChat).mockReturnValue(
      makeFailingStream(new LocalConnectionError(LOCAL_CONNECTION_MESSAGES.unavailable)) as never
    );

    await useChatStore.getState().sendMessageStream("Hi");

    const s = useChatStore.getState();
    expect(s.error).toBe(LOCAL_CONNECTION_MESSAGES.unavailable);
    expect(s.errorRetryable).toBe(true);
  });

  it("does not mark ordinary model errors retryable", async () => {
    await setupOllamaLocalChat();
    vi.mocked(streamLocalChat).mockReturnValue(
      makeFailingStream(new Error("Model not found (404). Check model ID and that the model is pulled.")) as never
    );

    await useChatStore.getState().sendMessageStream("Hi");

    expect(useChatStore.getState().errorRetryable).toBe(false);
  });
});

describe("chat store — retryLastMessage", () => {
  it("re-answers the last user message without duplicating it", async () => {
    await setupOllamaLocalChat();
    vi.mocked(ensureLocalModelConnection).mockResolvedValueOnce({
      ok: false,
      reason: "startup_failed",
      message: LOCAL_CONNECTION_MESSAGES.startup_failed,
    });

    await useChatStore.getState().sendMessageStream("What is 2+2?");
    expect(useChatStore.getState().errorRetryable).toBe(true);

    // Recovery works now: the retry streams a real answer.
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["It is ", "4."]) as never);
    await useChatStore.getState().retryLastMessage();

    const s = useChatStore.getState();
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What is 2+2?"],
      ["assistant", "It is 4."],
    ]);
    // Exactly one user message — never a duplicate.
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(s.error).toBeNull();
    expect(s.errorRetryable).toBe(false);
    // The retry goes through the same request path (ensure + stream).
    expect(ensureLocalModelConnection).toHaveBeenCalledTimes(2);
    expect(streamLocalChat).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the last message is an assistant reply", async () => {
    await setupOllamaLocalChat();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Answer"]) as never);
    await useChatStore.getState().sendMessageStream("Hello");
    expect(useChatStore.getState().messages).toHaveLength(2);

    vi.mocked(streamLocalChat).mockClear();
    await useChatStore.getState().retryLastMessage();

    expect(vi.mocked(streamLocalChat)).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it("is a no-op while a request is already streaming", async () => {
    await setupOllamaLocalChat();
    useChatStore.setState({ loading: true, isStreaming: true });
    vi.mocked(streamLocalChat).mockClear();

    await useChatStore.getState().retryLastMessage();

    expect(vi.mocked(streamLocalChat)).not.toHaveBeenCalled();
  });

  it("is a no-op with no chat loaded", async () => {
    useChatStore.setState({ currentChat: null, messages: [] });
    vi.mocked(streamLocalChat).mockClear();

    await useChatStore.getState().retryLastMessage();

    expect(vi.mocked(streamLocalChat)).not.toHaveBeenCalled();
  });
});

describe("chat store — connection lifecycle cleanup", () => {
  it("invalidates the connection card when switching chats", async () => {
    await setupOllamaLocalChat();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["ok"]) as never);
    await useChatStore.getState().sendMessageStream("Hello");
    const chatId = useChatStore.getState().currentChat!.id;

    // Simulate an in-flight card from a new request, then switch away.
    useLocalConnectionStore.setState({ phase: "checking", active: true });
    useChatStore.getState().setProvider("groq");
    await useChatStore.getState().loadChat(chatId);

    expect(useLocalConnectionStore.getState().phase).toBe("idle");
    expect(useLocalConnectionStore.getState().active).toBe(false);
  });

  it("invalidates the connection card on Stop", async () => {
    await setupOllamaLocalChat();
    useLocalConnectionStore.setState({ phase: "starting", active: true });

    useChatStore.getState().stopGeneration();

    expect(useLocalConnectionStore.getState().phase).toBe("idle");
    expect(useLocalConnectionStore.getState().active).toBe(false);
  });

  it("invalidates the connection card on store reset", async () => {
    useLocalConnectionStore.setState({ phase: "waiting_for_health", active: true });

    useChatStore.getState().reset();

    expect(useLocalConnectionStore.getState().phase).toBe("idle");
  });
});
