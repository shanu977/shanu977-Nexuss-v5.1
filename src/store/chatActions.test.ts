import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { Chat, Message } from "@/types/chats";
import { chatService } from "@/services/chat";
import db from "@/lib/db/db";
import { useWorkspaceStore } from "@/workspace/store";

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

describe("concurrent sends are prevented", () => {
  type Reply = { reply: string; provider: string; model: string };

  it("ignores a second send while a request is already in flight", async () => {
    const chat = makeChat("chat-guard", "Guard chat");
    await seed(chat, []);

    let resolveSend: ((value: Reply) => void) | undefined;
    sendMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      })
    );

    const first = useChatStore.getState().sendMessageStream("First");
    await Promise.resolve();
    await useChatStore.getState().sendMessageStream("Second");

    expect(sendMock).toHaveBeenCalledTimes(1);

    resolveSend!({ reply: "ok", provider: "groq", model: "llama-3.3-70b-versatile" });
    await first;

    const cs = useChatStore.getState();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cs.messages).toHaveLength(2); // 1 user + 1 assistant, no duplicate
  });

  it("ignores a regenerate while a request is already in flight", async () => {
    const chat = makeChat("chat-guard-r", "Guard chat");
    const userMsg = makeMessage("g1", "chat-guard-r", "user", "q");
    const asstMsg = makeMessage("g2", "chat-guard-r", "assistant", "a");
    await seed(chat, [userMsg, asstMsg]);

    let resolveSend: ((value: Reply) => void) | undefined;
    sendMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      })
    );

    const first = useChatStore.getState().sendMessageStream("Next");
    await Promise.resolve();
    await useChatStore.getState().regenerateResponse("g2");

    expect(sendMock).toHaveBeenCalledTimes(1);

    resolveSend!({ reply: "ok", provider: "groq", model: "llama-3.3-70b-versatile" });
    await first;

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("Path workspace context flows into chat requests", () => {
  beforeEach(async () => {
    await useWorkspaceStore.getState().disconnect();
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().disconnect();
  });

  it("omits workspaceContext when no workspace is connected", async () => {
    const chat = makeChat("chat-ws-off", "No workspace");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Hello");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeUndefined();
  });

  it("attaches a token-minimized workspace context for the question", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ws", "Workspace chat");
    await seed(chat, []);

    await useChatStore
      .getState()
      .sendMessageStream("Why does login.ts reject valid users?");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [req] = sendMock.mock.calls[0];
    expect(req.message).toBe("Why does login.ts reject valid users?");
    expect(req.workspaceContext).toBeTruthy();
    expect(req.workspaceContext).toContain("src/auth/login.ts");
    // The context is selected context, never the whole project.
    expect(req.workspaceContext!.length).toBeLessThan(20000);
    expect(req.image).toBeUndefined();
  });

  it("still sends the screen frame together with workspace context", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ws-img", "Workspace + frame");
    await seed(chat, []);

    await useChatStore
      .getState()
      .sendMessageStream("What is this error?", "data:image/jpeg;base64,FRAME");

    const [req] = sendMock.mock.calls[0];
    expect(req.image).toBe("data:image/jpeg;base64,FRAME");
    expect(req.workspaceContext).toBeTruthy();
  });

  it("answers a status question with workspace status, not file retrieval", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ws-status", "Workspace status");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Can you see my folder?");

    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeTruthy();
    expect(req.workspaceContext).toContain("is connected");
    expect(req.workspaceContext).not.toContain("### src/");
  });

  it("answers a manifest question with the workspace file list", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ws-manifest", "Workspace manifest");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("List my files.");

    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeTruthy();
    expect(req.workspaceContext).toContain("src/auth/login.ts");
    expect(req.workspaceContext).toContain("Directories:");
  });

  it("reports a disconnected workspace for a status question", async () => {
    const chat = makeChat("chat-ws-status-off", "No workspace");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Can you see my folder?");

    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeTruthy();
    expect(req.workspaceContext).toMatch(/no folder/i);
  });
});

describe("conversation-aware workspace references flow into chat requests", () => {
  beforeEach(async () => {
    await useWorkspaceStore.getState().disconnect();
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().disconnect();
  });

  it("resolves 'the first one' then 'it' across turns", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ref", "Reference chat");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("Find the python files.");
    let [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toContain("server/api.py");

    await useChatStore.getState().sendMessageStream("Open the first one.");
    [req] = sendMock.mock.calls[1];
    expect(req.workspaceContext).toContain("server/api.py");
    expect(req.workspaceContext).toMatch(/Referenced file/);

    await useChatStore.getState().sendMessageStream("What does it do?");
    [req] = sendMock.mock.calls[2];
    expect(req.workspaceContext).toContain("server/api.py");
  });

  it("answers 'what was the folder name?' with the actual folder name", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ref-name", "Folder name");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("What was the folder name?");

    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeTruthy();
    expect(req.workspaceContext).toContain("nexuss-sample");
  });

  it("keeps normal chat free of workspace context", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const chat = makeChat("chat-ref-normal", "Normal chat");
    await seed(chat, []);

    await useChatStore.getState().sendMessageStream("What is recursion?");

    const [req] = sendMock.mock.calls[0];
    expect(req.workspaceContext).toBeUndefined();
  });
});

describe("sendMessageStream with a workspace-change block", () => {
  function lastMessage(): Message {
    const messages = useChatStore.getState().messages;
    return messages[messages.length - 1];
  }

  beforeEach(async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pendingChanges: [], agentLog: [], changeError: null });
  });

  it("stages a valid block as a pending change and strips it from the reply", async () => {
    const chat = makeChat("chat-change-1", "Change it");
    await seed(chat, []);
    sendMock.mockResolvedValueOnce({
      reply: [
        "I'll change the endpoint.",
        "```workspace-change",
        JSON.stringify({ changes: [{ path: "server/api.py", content: "# updated\n" }] }),
        "```"
      ].join("\n"),
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await useChatStore.getState().sendMessageStream("Change the api endpoint");

    const msg = lastMessage();
    expect(msg.content).toContain("I'll change the endpoint.");
    expect(msg.content).not.toContain("workspace-change");
    expect(msg.content).not.toContain("changes");

    const s = useWorkspaceStore.getState();
    expect(s.pendingChanges).toHaveLength(1);
    expect(s.pendingChanges[0].path).toBe("server/api.py");
    expect(s.pendingChanges[0].kind).toBe("write");
    // Nothing written without approval.
    const bridge = useWorkspaceStore.getState().bridge as unknown as {
      read: (p: string) => Promise<string>;
    };
    expect(await bridge.read("server/api.py")).toContain("from fastapi import FastAPI");
  });

  it("never stages an escaping-path block and strips raw JSON from the reply", async () => {
    const chat = makeChat("chat-change-2", "Escape");
    await seed(chat, []);
    sendMock.mockResolvedValueOnce({
      reply: [
        "```workspace-change",
        JSON.stringify({ changes: [{ path: "../escape.ts", content: "x" }] }),
        "```",
        "I can't touch files outside the workspace."
      ].join("\n"),
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await useChatStore.getState().sendMessageStream("edit a file outside");

    const msg = lastMessage();
    expect(msg.content).toContain("I can't touch files outside the workspace.");
    expect(msg.content).not.toContain("workspace-change");
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
  });

  it("leaves normal code fences untouched and stages nothing", async () => {
    const chat = makeChat("chat-change-3", "Snippet");
    await seed(chat, []);
    sendMock.mockResolvedValueOnce({
      reply: "Here is the snippet:\n```ts\nconst x = 1;\n```",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await useChatStore.getState().sendMessageStream("show a snippet");

    const msg = lastMessage();
    expect(msg.content).toContain("```ts");
    expect(msg.content).toContain("const x = 1;");
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
  });
});

describe("sendMessageStream with a workspace-command block", () => {
  function lastMessage(): Message {
    const messages = useChatStore.getState().messages;
    return messages[messages.length - 1];
  }

  beforeEach(async () => {
    // A desktop runtime must be present for a run/test request to be staged.
    (window as unknown as {
      nexussDesktop: { runtime: { run: () => Promise<unknown>; test: () => Promise<unknown>; capabilities: () => { run: boolean; test: boolean } } }
    }).nexussDesktop = {
      runtime: {
        run: vi.fn(async () => ({})),
        test: vi.fn(async () => ({})),
        capabilities: () => ({ run: true, test: true })
      }
    };
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({
      pendingChanges: [],
      agentLog: [],
      changeError: null,
      pendingCommand: null,
      runningCommand: false,
      lastCommandResult: null,
      commandError: null
    });
  });

  afterEach(() => {
    (window as unknown as { nexussDesktop?: unknown }).nexussDesktop = undefined;
  });

  it("stages a run request and strips the fence from the reply", async () => {
    const chat = makeChat("chat-cmd-1", "Run it");
    await seed(chat, []);
    sendMock.mockResolvedValueOnce({
      reply: [
        "I'll run the tests.",
        "```workspace-command",
        JSON.stringify({ run: { command: "npm test" } }),
        "```"
      ].join("\n"),
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await useChatStore.getState().sendMessageStream("run the tests");

    const msg = lastMessage();
    expect(msg.content).toContain("I'll run the tests.");
    expect(msg.content).not.toContain("workspace-command");
    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand?.kind).toBe("run");
    expect(s.pendingCommand?.command).toBe("npm test");
  });

  it("strips the fence even when the command cannot be staged", async () => {
    const chat = makeChat("chat-cmd-2", "Run it");
    await seed(chat, []);
    sendMock.mockResolvedValueOnce({
      reply: [
        "```workspace-command",
        JSON.stringify({ run: { command: "" } }),
        "```",
        "Nothing to run here."
      ].join("\n"),
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await useChatStore.getState().sendMessageStream("run something");

    const msg = lastMessage();
    expect(msg.content).toContain("Nothing to run here.");
    expect(msg.content).not.toContain("workspace-command");
    expect(useWorkspaceStore.getState().pendingCommand).toBeNull();
  });
});
