import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { useLocalModelStore } from "@/store/localModelStore";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const state = {
    user: { uid: "user-a", displayName: "Priya Sharma" } as unknown,
  };
  return {
    authMock: {
      useAuthStore: {
        getState: () => state,
      },
    },
    state,
  };
});
vi.mock("@/store/useAuthStore", () => mocks.authMock);
vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue({ provider: "local", model: "qwen2.5-coder:7b", theme: "light" }),
    update: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("@/services/localModels", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...(orig as object),
    streamLocalChat: vi.fn(),
  };
});
import { streamLocalChat } from "@/services/localModels";

function makeStream(chunks: string[]) {
  return (async function* () {
    for (const c of chunks) yield { type: "chunk", content: c } as const;
    yield { type: "done" } as const;
  })();
}

async function setupLocalModel() {
  const p = await useLocalModelStore.getState().addProvider({
    name: "Ollama",
    providerType: "ollama",
    endpoint: "http://localhost:11434/v1",
  });
  await useLocalModelStore.getState().addModel(p.id, "qwen2.5-coder:7b");
  useChatStore.getState().setProvider("local");
  useChatStore.getState().setModel("qwen2.5-coder:7b");
}

beforeEach(async () => {
  mocks.state.user = { uid: "user-a", displayName: "Priya Sharma" };
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
    provider: "local",
    model: "qwen2.5-coder:7b",
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

describe("local chat identity injection", () => {
  it("includes the user's display name in a system message", async () => {
    await setupLocalModel();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hey Priya!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    const [params] = vi.mocked(streamLocalChat).mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const identity = params.messages.find((m) => m.role === "system" && m.content.includes("user's name is"));
    expect(identity).toBeTruthy();
    expect(identity!.content).toContain("Priya Sharma");
  });

  it("does not put the email in any prompt message", async () => {
    mocks.state.user = { uid: "user-a", displayName: "Priya Sharma", email: "priya@example.com" };
    await setupLocalModel();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hello!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    const [params] = vi.mocked(streamLocalChat).mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const all = params.messages.map((m) => m.content).join("\n");
    expect(all).not.toContain("priya@example.com");
  });

  it("omits the identity message when displayName is missing", async () => {
    mocks.state.user = { uid: "user-a", displayName: null };
    await setupLocalModel();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hello!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    const [params] = vi.mocked(streamLocalChat).mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const identity = params.messages.find((m) => m.content.includes("user's name is"));
    expect(identity).toBeUndefined();
  });

  it("omits the identity message when displayName is blank", async () => {
    mocks.state.user = { uid: "user-a", displayName: "   " };
    await setupLocalModel();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Hello!"]) as never);

    await useChatStore.getState().sendMessageStream("Hi");

    const [params] = vi.mocked(streamLocalChat).mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const identity = params.messages.find((m) => m.content.includes("user's name is"));
    expect(identity).toBeUndefined();
  });

  it("keeps the identity message as system role in lightweight path", async () => {
    await setupLocalModel();
    vi.mocked(streamLocalChat).mockReturnValue(makeStream(["Sure!"]) as never);

    await useChatStore.getState().sendMessageStream("hello"); // "none" intent -> lightweight path

    const [params] = vi.mocked(streamLocalChat).mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const first = params.messages[0];
    expect(first.role).toBe("system");
    const identity = params.messages.find((m) => m.role === "system" && m.content.includes("user's name is"));
    expect(identity).toBeTruthy();
    // Identity must come before history/user messages
    const idxIdentity = params.messages.indexOf(identity!);
    const idxUser = params.messages.findIndex((m) => m.role === "user");
    expect(idxIdentity).toBeLessThan(idxUser);
  });
});
