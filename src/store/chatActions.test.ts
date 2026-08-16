import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { Chat, Message } from "@/types/chats";
import { chatService } from "@/services/chat";
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
  settingsService: { get: vi.fn(), update: vi.fn() }
}));

const UID = "user-a";
const setMockUser = mocks.setMockUser;
const sendMock = vi.mocked(chatService.send);

function makeChat(id: string, title: string): Chat {
  return { id, userId: UID, title, provider: "groq", createdAt: 1, updatedAt: 1 };
}

function makeMessage(
  id: string,
  chatId: string,
  role: "user" | "assistant",
  content: string,
  timestamp = 1
): Message {
  return { id, chatId, role, content, timestamp };
}

async function seed(chat: Chat, messages: Message[]) {
  await db.chats.add(chat);
  await db.messages.bulkAdd(messages);
  useChatStore.setState({
    currentChat: chat,
    chats: [chat],
    messages,
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    loading: false,
    error: null,
    isStreaming: false,
    streamingMessage: ""
  });
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
    streamingMessage: "",
    theme: "light"
  });
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    reply: "edited assistant reply",
    provider: "groq",
    model: "llama-3.3-70b-versatile"
  });
});

describe("editMessageAndRegenerate", () => {
  it("replaces the edited user message and the old assistant reply, then regenerates", async () => {
    const chat = makeChat("chat-1", "My chat");
    const userMsg = makeMessage("m1", "chat-1", "user", "Explain React hooks");
    const asstMsg = makeMessage("m2", "chat-1", "assistant", "Hooks let you use state.");
    await seed(chat, [userMsg, asstMsg]);

    await useChatStore
      .getState()
      .editMessageAndRegenerate("m1", "Explain React hooks with examples");

    const cs = useChatStore.getState();
    expect(cs.messages).toHaveLength(2);
    expect(cs.messages[0].role).toBe("user");
    expect(cs.messages[0].content).toBe("Explain React hooks with examples");
    expect(cs.messages[0].id).not.toBe("m1");
    expect(cs.messages[1].role).toBe("assistant");
    expect(cs.messages[1].content).toBe("edited assistant reply");

    // Old messages must be gone from IndexedDB.
    const stored = await db.messages.where("chatId").equals("chat-1").sortBy("timestamp");
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.content)).toEqual([
      "Explain React hooks with examples",
      "edited assistant reply"
    ]);

    // Request carries the edited text with only prior context as history.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("Explain React hooks with examples");
    expect(req.history).toEqual([]);
  });

  it("drops messages generated after the edited message", async () => {
    const chat = makeChat("chat-1", "My chat");
    await seed(chat, [
      makeMessage("m1", "chat-1", "user", "question one"),
      makeMessage("m2", "chat-1", "assistant", "answer one"),
      makeMessage("m3", "chat-1", "user", "question two"),
      makeMessage("m4", "chat-1", "assistant", "answer two")
    ]);

    await useChatStore.getState().editMessageAndRegenerate("m1", "edited question one");

    const cs = useChatStore.getState();
    expect(cs.messages.map((m) => m.content)).toEqual([
      "edited question one",
      "edited assistant reply"
    ]);
    const stored = await db.messages.where("chatId").equals("chat-1").toArray();
    expect(stored).toHaveLength(2);
  });

  it("does nothing when the target is an assistant message", async () => {
    const chat = makeChat("chat-1", "My chat");
    const userMsg = makeMessage("m1", "chat-1", "user", "hi");
    const asstMsg = makeMessage("m2", "chat-1", "assistant", "hello");
    await seed(chat, [userMsg, asstMsg]);

    await useChatStore.getState().editMessageAndRegenerate("m2", "nope");

    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing for a chat owned by another user", async () => {
    const foreign = {
      id: "chat-foreign",
      userId: "user-b",
      title: "Theirs",
      provider: "groq" as const,
      createdAt: 1,
      updatedAt: 1
    };
    await db.chats.add(foreign);
    await db.messages.add(makeMessage("m1", "chat-foreign", "user", "their message"));
    useChatStore.setState({
      currentChat: foreign,
      chats: [foreign],
      messages: [makeMessage("m1", "chat-foreign", "user", "their message")]
    });

    await useChatStore.getState().editMessageAndRegenerate("m1", "hijacked");

    const stored = await db.messages.get("m1");
    expect(stored?.content).toBe("their message");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("regenerateResponse", () => {
  it("replaces the assistant response for the preceding user turn and keeps prior turns", async () => {
    const chat = makeChat("chat-1", "My chat");
    await seed(chat, [
      makeMessage("m1", "chat-1", "user", "Explain hooks"),
      makeMessage("m2", "chat-1", "assistant", "old answer"),
      makeMessage("m3", "chat-1", "user", "And a follow up"),
      makeMessage("m4", "chat-1", "assistant", "old follow-up answer")
    ]);

    await useChatStore.getState().regenerateResponse("m4");

    const cs = useChatStore.getState();
    expect(cs.messages.map((m) => m.content)).toEqual([
      "Explain hooks",
      "old answer",
      "And a follow up",
      "edited assistant reply"
    ]);

    // The user message being re-answered is the request message; history is
    // everything before it.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("And a follow up");
    expect(req.history).toEqual([
      { role: "user", content: "Explain hooks" },
      { role: "assistant", content: "old answer" }
    ]);

    const stored = await db.messages.where("chatId").equals("chat-1").sortBy("timestamp");
    expect(stored.map((m) => m.content)).toEqual([
      "Explain hooks",
      "old answer",
      "And a follow up",
      "edited assistant reply"
    ]);
  });

  it("does nothing when the target is a user message", async () => {
    const chat = makeChat("chat-1", "My chat");
    await seed(chat, [
      makeMessage("m1", "chat-1", "user", "hi"),
      makeMessage("m2", "chat-1", "assistant", "hello")
    ]);

    await useChatStore.getState().regenerateResponse("m1");

    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is no preceding user message", async () => {
    const chat = makeChat("chat-1", "My chat");
    await seed(chat, [makeMessage("m2", "chat-1", "assistant", "orphan")]);

    await useChatStore.getState().regenerateResponse("m2");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("sendMessageStream with a screen frame", () => {
  it("sends the captured frame together with the question", async () => {
    const chat = makeChat("chat-screen", "Screen chat");
    await seed(chat, []);

    await useChatStore
      .getState()
      .sendMessageStream("What is this error?", "data:image/jpeg;base64,FRAME");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("What is this error?");
    expect(req.image).toBe("data:image/jpeg;base64,FRAME");

    // The frame is transient: only the text is persisted as the user message.
    const stored = await db.messages
      .where("chatId")
      .equals("chat-screen")
      .sortBy("timestamp");
    expect(stored).toHaveLength(2); // user + assistant
    expect(stored[0].content).toBe("What is this error?");
  });

  it("omits the image field when sending without screen sharing", async () => {
    const chat = makeChat("chat-text", "Text chat");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Hello");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("Hello");
    expect(req.image).toBeUndefined();
  });
});
