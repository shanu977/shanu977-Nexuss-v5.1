import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { useLocalModelStore } from "@/store/localModelStore";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const current = { uid: "user-a" };
  return {
    authMock: {
      useAuthStore: {
        getState: () => ({ user: { uid: current.uid } }),
      },
    },
    setUid: (uid: string) => {
      current.uid = uid;
    },
  };
});
vi.mock("@/store/useAuthStore", () => mocks.authMock);
vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: { get: vi.fn().mockResolvedValue({ provider: "groq", model: "openai/gpt-oss-120b", theme: "light" }), update: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/services/localModels", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...(orig as object),
    streamLocalChat: vi.fn(),
    testLocalEndpoint: vi.fn().mockResolvedValue({ ok: true, message: "ok", models: ["llama3.2:3b"], endpointReachable: true, modelsDiscoverable: true }),
  };
});
import { chatService } from "@/services/chat";
import { streamLocalChat } from "@/services/localModels";

function makeStream(chunks: string[]) {
  return (async function* () {
    for (const c of chunks) yield { type: "chunk", content: c } as const;
    yield { type: "done" } as const;
  })();
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
    theme: "light",
  });
  useLocalModelStore.setState({ providers: [], models: [], hydrated: false });
  vi.clearAllMocks();
});

describe("local chat integration", () => {
  it("local model appears in selector and can be selected", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
    useChatStore.getState().setProvider("local");
    expect(useChatStore.getState().provider).toBe("local");
    expect(useChatStore.getState().model).toBe("llama3.2:3b");
  });

  it("local chat streams via local endpoint without cloud API key", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("llama3.2:3b");
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hello ", "from local!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi there");

    expect(streamLocalChat).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://localhost:11434/v1", modelId: "llama3.2:3b" })
    );
    expect(chatService.sendStream).not.toHaveBeenCalled();
    const cs = useChatStore.getState();
    expect(cs.messages.map((m) => m.content)).toEqual(["Hi there", "Hello from local!"]);
    expect(cs.provider).toBe("local");
  });

  it("local chat streams multiple chunks correctly", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "LM Studio",
      providerType: "lmstudio",
      endpoint: "http://localhost:1234/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "qwen2.5:7b");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("qwen2.5:7b");
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Q", "wen ", "reply"]) as never);
    await useChatStore.getState().sendMessageStream("Hello");
    expect(useChatStore.getState().messages[1].content).toBe("Qwen reply");
  });

  it("local server unavailable shows error", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "mistral");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("mistral");
    vi.mocked(streamLocalChat).mockImplementation(() => {
      throw new Error("Cannot connect to local model. Check that the server is running and CORS is configured");
    });
    // streamLocalChat is async generator, so mock should return a generator that throws
    vi.mocked(streamLocalChat).mockReturnValue((async function* () { throw new Error("Cannot connect to local model."); })() as never);
    await useChatStore.getState().sendMessageStream("Hi");
    expect(useChatStore.getState().error).toContain("Cannot connect");
  });

  it("invalid endpoint model not found shows error", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Generic",
      providerType: "generic",
      endpoint: "http://localhost:8000/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "nonexistent-model");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("nonexistent-model");
    vi.mocked(streamLocalChat).mockReturnValue((async function* () { throw new Error("Model not found (404)."); })() as never);
    await useChatStore.getState().sendMessageStream("Hi");
    expect(useChatStore.getState().error).toContain("Model not found");
  });

  it("existing cloud providers still work after local addition", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
    // Switch back to cloud
    useChatStore.getState().setProvider("groq");
    expect(useChatStore.getState().provider).toBe("groq");
    const { chatService: cs } = await import("@/services/chat");
    vi.mocked(cs.sendStream).mockReturnValue(
      (async function* () {
        yield { type: "chunk", content: "Cloud reply" } as const;
        yield { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, provider: "groq", model: "openai/gpt-oss-120b", fallback_used: null, attempts: [] } as const;
      })()
    );
    await useChatStore.getState().sendMessageStream("Hello cloud");
    expect(vi.mocked(cs.sendStream)).toHaveBeenCalled();
    expect(useChatStore.getState().messages[1].content).toBe("Cloud reply");
  });

  it("removing local model does not delete chat history", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    const m = await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
    useChatStore.getState().setProvider("local");
    useChatStore.getState().setModel("llama3.2:3b");
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["hi"]) as never);
    await useChatStore.getState().sendMessageStream("Hello");
    const chatId = useChatStore.getState().currentChat!.id;
    await useLocalModelStore.getState().removeModel(m.id);
    const chat = await db.chats.get(chatId);
    expect(chat).toBeDefined();
    const msgs = await db.messages.where("chatId").equals(chatId).toArray();
    expect(msgs.length).toBeGreaterThan(0);
  });
});
