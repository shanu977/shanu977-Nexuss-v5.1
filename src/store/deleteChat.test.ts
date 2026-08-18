import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { getLastChatId, setLastChatId } from "@/storage/localStorage";
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

function makeChat(id: string, title: string): Chat {
  return { id, userId: UID, title, provider: "groq", createdAt: 1, updatedAt: 1 };
}

function makeMessage(id: string, chatId: string, role: "user" | "assistant", content: string): Message {
  return { id, chatId, role, content, timestamp: 1 };
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.clear();
    await db.messages.clear();
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
    theme: "light"
  });
});

describe("deleteChat", () => {
  it("removes the chat and its messages, clearing currentChat when it is the active chat", async () => {
    const active = makeChat("chat-1", "Active");
    await db.chats.bulkAdd([active, makeChat("chat-2", "Other")]);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-1", "user", "hi"),
      makeMessage("m2", "chat-2", "user", "other")
    ]);
    useChatStore.setState({
      chats: [active, makeChat("chat-2", "Other")],
      currentChat: active,
      messages: [makeMessage("m1", "chat-1", "user", "hi")]
    });
    setLastChatId(UID, "chat-1");

    await useChatStore.getState().deleteChat("chat-1");

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-2"]);
    expect(cs.currentChat).toBeNull();
    expect(cs.messages).toEqual([]);
    expect(getLastChatId(UID)).toBeNull();

    const remaining = await db.messages.toArray();
    expect(remaining.map((m) => m.chatId)).toEqual(["chat-2"]);
  });

  it("keeps the active chat and its messages when deleting a different chat", async () => {
    const active = makeChat("chat-1", "Active");
    await db.chats.bulkAdd([active, makeChat("chat-2", "Other")]);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-1", "user", "keep me"),
      makeMessage("m2", "chat-2", "user", "other")
    ]);
    useChatStore.setState({
      chats: [active, makeChat("chat-2", "Other")],
      currentChat: active,
      messages: [makeMessage("m1", "chat-1", "user", "keep me")]
    });
    setLastChatId(UID, "chat-1");

    await useChatStore.getState().deleteChat("chat-2");

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-1"]);
    expect(cs.currentChat?.id).toBe("chat-1");
    expect(cs.messages.map((m) => m.content)).toEqual(["keep me"]);
    expect(getLastChatId(UID)).toBe("chat-1");
  });

  it("does not restore a deleted chat after re-hydration (refresh)", async () => {
    await db.chats.bulkAdd([
      makeChat("chat-1", "Active"),
      makeChat("chat-2", "Other")
    ]);
    await db.messages.bulkAdd([makeMessage("m1", "chat-1", "user", "hi")]);
    useChatStore.setState({
      chats: [makeChat("chat-1", "Active"), makeChat("chat-2", "Other")],
      currentChat: makeChat("chat-1", "Active"),
      messages: [makeMessage("m1", "chat-1", "user", "hi")]
    });
    setLastChatId(UID, "chat-1");

    await useChatStore.getState().deleteChat("chat-1");
    expect(getLastChatId(UID)).toBeNull();

    await useChatStore.getState().hydrate();

    const cs = useChatStore.getState();
    expect(cs.chats.map((c) => c.id)).toEqual(["chat-2"]);
    expect(cs.chats.some((c) => c.id === "chat-1")).toBe(false);
    expect(cs.currentChat?.id).toBe("chat-2");
  });

  it("does not delete a chat owned by another user", async () => {
    await db.chats.bulkAdd([
      makeChat("chat-1", "Mine"),
      { id: "chat-foreign", userId: "user-b", title: "Theirs", provider: "groq", createdAt: 1, updatedAt: 1 }
    ]);
    await db.messages.bulkAdd([
      makeMessage("m1", "chat-foreign", "user", "their secret")
    ]);
    useChatStore.setState({ chats: [makeChat("chat-1", "Mine")] });

    await useChatStore.getState().deleteChat("chat-foreign");

    const foreign = await db.chats.get("chat-foreign");
    expect(foreign).toBeDefined();
    const msgs = await db.messages.where("chatId").equals("chat-foreign").toArray();
    expect(msgs).toHaveLength(1);
  });
});
