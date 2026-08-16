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

  it("sends a fresh screen frame with the edited question when sharing is active", async () => {
    const chat = makeChat("chat-1", "My chat");
    const userMsg = makeMessage("m1", "chat-1", "user", "Explain React hooks");
    const asstMsg = makeMessage("m2", "chat-1", "assistant", "Hooks let you use state.");
    await seed(chat, [userMsg, asstMsg]);

    await useChatStore
      .getState()
      .editMessageAndRegenerate(
        "m1",
        "Explain hooks with examples",
        "data:image/jpeg;base64,FRAME"
      );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("Explain hooks with examples");
    expect(req.image).toBe("data:image/jpeg;base64,FRAME");
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

  it("sends a fresh screen frame with the regenerated question when sharing is active", async () => {
    const chat = makeChat("chat-1", "My chat");
    await seed(chat, [
      makeMessage("m1", "chat-1", "user", "Explain hooks"),
      makeMessage("m2", "chat-1", "assistant", "old answer")
    ]);

    await useChatStore
      .getState()
      .regenerateResponse("m2", "data:image/jpeg;base64,FRAME2");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("Explain hooks");
    expect(req.image).toBe("data:image/jpeg;base64,FRAME2");
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

  it("sends a fresh frame for every question in the same chat", async () => {
    const chat = makeChat("chat-multi", "Multi frame chat");
    await seed(chat, []);

    await useChatStore
      .getState()
      .sendMessageStream("Q1", "data:image/jpeg;base64,FRAME1");
    await useChatStore
      .getState()
      .sendMessageStream("Q2", "data:image/jpeg;base64,FRAME2");
    await useChatStore
      .getState()
      .sendMessageStream("Q3", "data:image/jpeg;base64,FRAME3");

    expect(sendMock).toHaveBeenCalledTimes(3);
    const frames = sendMock.mock.calls.map(([req]) => req.image);
    expect(frames).toEqual([
      "data:image/jpeg;base64,FRAME1",
      "data:image/jpeg;base64,FRAME2",
      "data:image/jpeg;base64,FRAME3"
    ]);

    // Screen-share requests do not change the user's selected model/provider
    // (the backend answers with a server-side vision model), so the dropdown
    // stays valid for every subsequent question.
    const reqs = sendMock.mock.calls.map(([req]) => [req.provider, req.model]);
    expect(new Set(reqs.map((r) => r.join(":"))).size).toBe(1);
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

describe("reasoning is filtered out of every assistant reply", () => {
  const reasoningReply = [
    " thinking",
    "The user's screen shows an error.",
    "This is internal reasoning that must never be shown.",
    " response",
    "The fix is to install pandas."
  ].join("\n");

  beforeEach(() => {
    sendMock.mockResolvedValue({
      reply: reasoningReply,
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });
  });

  it("stores a filtered reply for a normal send", async () => {
    const chat = makeChat("chat-r", "Reasoning chat");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Why does this fail?");

    const cs = useChatStore.getState();
    expect(cs.messages[1].role).toBe("assistant");
    expect(cs.messages[1].content).toBe("The fix is to install pandas.");
    expect(cs.messages[1].content).not.toContain("thinking");
    expect(cs.messages[1].content).not.toContain("internal reasoning");
  });

  it("stores a filtered reply after editing a message", async () => {
    const chat = makeChat("chat-edit-r", "Edit chat");
    await seed(chat, [
      makeMessage("m1", "chat-edit-r", "user", "Explain hooks"),
      makeMessage("m2", "chat-edit-r", "assistant", "old answer")
    ]);

    await useChatStore.getState().editMessageAndRegenerate("m1", "Explain hooks better");

    const cs = useChatStore.getState();
    expect(cs.messages[1].role).toBe("assistant");
    expect(cs.messages[1].content).toBe("The fix is to install pandas.");
    expect(cs.messages[1].content).not.toContain("thinking");
  });

  it("stores a filtered reply after regenerating a response", async () => {
    const chat = makeChat("chat-regen-r", "Regen chat");
    await seed(chat, [
      makeMessage("m1", "chat-regen-r", "user", "Explain hooks"),
      makeMessage("m2", "chat-regen-r", "assistant", "old answer")
    ]);

    await useChatStore.getState().regenerateResponse("m2");

    const cs = useChatStore.getState();
    expect(cs.messages[1].role).toBe("assistant");
    expect(cs.messages[1].content).toBe("The fix is to install pandas.");
    expect(cs.messages[1].content).not.toContain("thinking");
  });
});

describe("reasoning-only reply must not poison the next request (production 422)", () => {
  const reasoningOnly = " thinking\nThis is internal reasoning with no answer produced.";

  beforeEach(() => {
    sendMock.mockResolvedValue({
      reply: reasoningOnly,
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });
  });

  it("stores a non-empty assistant message and never sends an empty history turn", async () => {
    const chat = makeChat("chat-empty-r", "Empty reply chat");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("first question");

    // The reply is 100% internal reasoning: there is no answer to show. The
    // stored assistant message must still be a valid, non-empty string so the
    // conversation stays usable.
    const cs = useChatStore.getState();
    expect(cs.messages).toHaveLength(2);
    expect(cs.messages[1].role).toBe("assistant");
    expect(cs.messages[1].content.length).toBeGreaterThan(0);

    await useChatStore.getState().sendMessageStream("second question");

    const [req] = sendMock.mock.calls[1];
    // A prior empty assistant turn would be rejected by the backend schema
    // (ChatTurn.content has min_length=1), producing the production 422.
    for (const turn of req.history) {
      expect(turn.content.length).toBeGreaterThan(0);
    }
  });

  it("drops any legacy empty assistant messages when building history", async () => {
    const chat = makeChat("chat-legacy-empty", "Legacy chat");
    await seed(chat, [
      makeMessage("m1", "chat-legacy-empty", "user", "q1"),
      makeMessage("m2", "chat-legacy-empty", "assistant", ""),
      makeMessage("m3", "chat-legacy-empty", "user", "q2"),
      makeMessage("m4", "chat-legacy-empty", "assistant", "ok")
    ]);

    await useChatStore.getState().sendMessageStream("q3");

    const [req] = sendMock.mock.calls[0];
    expect(req.history.some((t: { content: string }) => t.content === "")).toBe(false);
    expect(req.history).toHaveLength(3);
  });
});

describe("long conversations must keep working (20+ messages in one chat)", () => {
  beforeEach(() => {
    sendMock.mockResolvedValue({
      reply: "A concise reply.",
      provider: "groq",
      model: "llama-3.3-70b-versatile"
    });
  });

  it("sends 20 sequential messages with no duplicates and valid history", async () => {
    const chat = makeChat("chat-20", "Twenty-message chat");
    await seed(chat, []);

    for (let i = 1; i <= 20; i++) {
      await useChatStore.getState().sendMessageStream(`message number ${i}`);
    }

    const cs = useChatStore.getState();
    expect(cs.messages).toHaveLength(40); // 20 user + 20 assistant, none duplicated
    expect(new Set(cs.messages.map((m) => m.id)).size).toBe(40);
    expect(sendMock).toHaveBeenCalledTimes(20);

    // History grows linearly (2 prior turns per previous message), stays under
    // the backend's 100-turn cap, and never contains an empty or stray turn.
    sendMock.mock.calls.forEach(([req], i) => {
      expect(req.history).toHaveLength(2 * i);
      expect(req.history.length).toBeLessThanOrEqual(99);
      for (const turn of req.history) {
        expect(turn.content.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it("sends 20 screen-share messages, each carrying only its own fresh frame", async () => {
    const chat = makeChat("chat-20f", "Twenty-frame chat");
    await seed(chat, []);

    for (let i = 1; i <= 20; i++) {
      await useChatStore
        .getState()
        .sendMessageStream(`What is on screen ${i}?`, `data:image/jpeg;base64,FRAME${i}`);
    }

    // Every request carries exactly its own frame; no frame ever accumulates.
    sendMock.mock.calls.forEach(([req], i) => {
      expect(req.image).toBe(`data:image/jpeg;base64,FRAME${i + 1}`);
    });
    // Frames never leak into the persisted user messages or into history.
    const cs = useChatStore.getState();
    for (const m of cs.messages) {
      expect(m.content.startsWith("data:image/")).toBe(false);
    }
    sendMock.mock.calls.forEach(([req]) => {
      for (const turn of req.history) {
        expect(turn.content.startsWith("data:image/")).toBe(false);
      }
    });
  });
});
