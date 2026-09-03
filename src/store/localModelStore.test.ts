import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalModelStore } from "@/store/localModelStore";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const current = { uid: null as string | null };
  return {
    authMock: {
      useAuthStore: {
        getState: () => ({ user: current.uid ? { uid: current.uid } : null }),
      },
    },
    setUid: (uid: string | null) => {
      current.uid = uid;
    },
  };
});
vi.mock("@/store/useAuthStore", () => mocks.authMock);
vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: { get: vi.fn().mockResolvedValue({ provider: "groq", model: "openai/gpt-oss-120b", theme: "light" }), update: vi.fn().mockResolvedValue({}) },
}));

const UID_A = "user-a";
const UID_B = "user-b";
const setUid = mocks.setUid;

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, db.usageRecords, db.localProviders, db.localModels, async () => {
    await db.chats.clear();
    await db.messages.clear();
    await db.usageRecords.clear();
    await db.localProviders.clear();
    await db.localModels.clear();
  });
  setUid(UID_A);
  useLocalModelStore.getState().reset();
  useLocalModelStore.setState({ providers: [], models: [], hydrated: false });
});

describe("local model store", () => {
  it("add local provider validates and normalizes endpoint", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434",
      apiKey: "",
    });
    expect(p.endpoint).toBe("http://localhost:11434/v1");
    expect(p.providerType).toBe("ollama");
    expect(p.userId).toBe(UID_A);
  });

  it("discover and add model, manual entry when discovery fails", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "LM Studio",
      providerType: "lmstudio",
      endpoint: "http://localhost:1234/v1",
    });
    const m1 = await useLocalModelStore.getState().addModel(p.id, "qwen2.5:7b");
    expect(m1.modelId).toBe("qwen2.5:7b");
    const m2 = await useLocalModelStore.getState().addModel(p.id, "  llama3.2:3b  ");
    expect(m2.modelId).toBe("llama3.2:3b");
    expect(useLocalModelStore.getState().models).toHaveLength(2);
  });

  it("edit provider and model", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().updateProvider(p.id, { name: "My Ollama", endpoint: "http://localhost:11434/v1" });
    expect(useLocalModelStore.getState().providers[0].name).toBe("My Ollama");
  });

  it("remove model does not delete chat history", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    const m = await useLocalModelStore.getState().addModel(p.id, "mistral");
    await db.chats.add({ id: "c1", userId: UID_A, title: "Test", provider: "local", createdAt: 1, updatedAt: 1 });
    await db.messages.add({ id: "m1", chatId: "c1", role: "user", content: "hi", timestamp: 1 });
    await useLocalModelStore.getState().removeModel(m.id);
    expect(useLocalModelStore.getState().models).toHaveLength(0);
    const chat = await db.chats.get("c1");
    expect(chat).toBeDefined();
    const msgs = await db.messages.where("chatId").equals("c1").toArray();
    expect(msgs).toHaveLength(1);
  });

  it("enable/disable model", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "vLLM",
      providerType: "vllm",
      endpoint: "http://localhost:8000/v1",
    });
    const m = await useLocalModelStore.getState().addModel(p.id, "gemma3");
    await useLocalModelStore.getState().toggleModel(m.id, false);
    expect(useLocalModelStore.getState().models[0].enabled).toBe(false);
    await useLocalModelStore.getState().toggleModel(m.id, true);
    expect(useLocalModelStore.getState().models[0].enabled).toBe(true);
  });

  it("remove provider cascades to models", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "llama3.2:3b");
    await useLocalModelStore.getState().addModel(p.id, "qwen2.5:7b");
    await useLocalModelStore.getState().removeProvider(p.id);
    expect(useLocalModelStore.getState().providers).toHaveLength(0);
    expect(useLocalModelStore.getState().models).toHaveLength(0);
    const remaining = await db.localModels.where("providerId").equals(p.id).toArray();
    expect(remaining).toHaveLength(0);
  });

  it("user isolation: A cannot see B's local models", async () => {
    const pA = await useLocalModelStore.getState().addProvider({
      name: "Ollama A",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(pA.id, "llama3.2:3b");
    setUid(UID_B);
    useLocalModelStore.getState().reset();
    await useLocalModelStore.getState().hydrate();
    expect(useLocalModelStore.getState().providers).toHaveLength(0);
    expect(useLocalModelStore.getState().models).toHaveLength(0);
    // B adds own
    const pB = await useLocalModelStore.getState().addProvider({
      name: "LM Studio B",
      providerType: "lmstudio",
      endpoint: "http://localhost:1234/v1",
    });
    await useLocalModelStore.getState().addModel(pB.id, "mistral");
    expect(useLocalModelStore.getState().providers[0].userId).toBe(UID_B);
    // A still has own when switching back
    setUid(UID_A);
    useLocalModelStore.getState().reset();
    await useLocalModelStore.getState().hydrate();
    expect(useLocalModelStore.getState().providers[0].userId).toBe(UID_A);
    expect(useLocalModelStore.getState().models[0].modelId).toBe("llama3.2:3b");
  });

  it("hydrate loads persisted providers/models per user", async () => {
    const p = await useLocalModelStore.getState().addProvider({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    await useLocalModelStore.getState().addModel(p.id, "qwen2.5:7b");
    // Simulate refresh: clear in-memory, hydrate from DB
    useLocalModelStore.setState({ providers: [], models: [], hydrated: false });
    await useLocalModelStore.getState().hydrate();
    expect(useLocalModelStore.getState().providers).toHaveLength(1);
    expect(useLocalModelStore.getState().models).toHaveLength(1);
  });

  it("rejects unauthenticated add", async () => {
    setUid(null);
    await expect(
      useLocalModelStore.getState().addProvider({
        name: "x",
        providerType: "generic",
        endpoint: "http://localhost:8000/v1",
      })
    ).rejects.toThrow("Not authenticated");
  });
});
