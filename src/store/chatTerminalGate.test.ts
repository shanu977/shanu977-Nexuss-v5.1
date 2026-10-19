import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { Chat, Message } from "@/types/chats";
import { chatService, ChatStreamEvent } from "@/services/chat";
import db from "@/lib/db/db";
import { useWorkspaceStore } from "@/workspace/store";
import {
  TERMINAL_CONNECT_REQUIRED_MESSAGE,
  useTerminalConnectionStore,
  resetTerminalConnection
} from "@/workspace/terminalConnection";

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
    },
    runAuthorizedGoal: vi.fn()
  };
});

vi.mock("@/store/useAuthStore", () => mocks.authStoreMock);

vi.mock("@/services/chat", () => ({
  chatService: { sendStream: vi.fn() }
}));

vi.mock("@/services/settings", () => ({
  settingsService: { get: vi.fn(), update: vi.fn() }
}));

vi.mock("@/workspace/agent/authorizedExecutor", () => ({
  runAuthorizedGoal: mocks.runAuthorizedGoal
}));

const UID = "user-gate";
const sendStreamMock = vi.mocked(chatService.sendStream);

function streamOf(reply: string): AsyncGenerator<ChatStreamEvent> {
  async function* gen() {
    yield { type: "chunk", content: reply } as ChatStreamEvent;
    yield {
      type: "usage",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      fallback_used: null,
      attempts: []
    } as ChatStreamEvent;
  }
  return gen();
}

function makeChat(id: string): Chat {
  return { id, userId: UID, title: "Gate", provider: "groq", createdAt: 1, updatedAt: 1 };
}

async function seed(chat: Chat) {
  await db.chats.add(chat);
  useChatStore.setState({
    currentChat: chat,
    chats: [chat],
    messages: [],
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    loading: false,
    error: null,
    isStreaming: false,
    streamingMessageId: null
  });
}

function lastMessage(): Message | undefined {
  const messages = useChatStore.getState().messages;
  return messages[messages.length - 1];
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.clear();
    await db.messages.clear();
  });
  mocks.setMockUser(UID);
  resetTerminalConnection();
  mocks.runAuthorizedGoal.mockReset();
  useWorkspaceStore.setState({ panelOpen: false, workspacePath: null });
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
  sendStreamMock.mockReset();
  sendStreamMock.mockReturnValue(streamOf("model reply"));
});

describe("terminal gate in chat", () => {
  it("answers an action with the Terminal access required card while disconnected", async () => {
    const chat = makeChat("chat-gate");
    await seed(chat);

    await useChatStore.getState().sendMessageStream("create a folder called gate-test");

    const msg = lastMessage();
    expect(msg?.role).toBe("assistant");
    expect(msg?.content).toBe(TERMINAL_CONNECT_REQUIRED_MESSAGE);
    expect(mocks.runAuthorizedGoal).not.toHaveBeenCalled();
    expect(sendStreamMock).not.toHaveBeenCalled();
    // Never leak a technical failure into the conversation.
    expect(msg?.content).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|Failed to fetch/);
  });

  it("executes the action through the authorized executor when connected", async () => {
    const chat = makeChat("chat-gate");
    await seed(chat);
    useTerminalConnectionStore.setState({
      status: "connected",
      lastVerifiedAt: Date.now(),
      justConnected: false,
      lastError: null
    });
    mocks.runAuthorizedGoal.mockResolvedValue({
      executed: 1,
      succeeded: 1,
      failed: 0,
      observations: [],
      finalResponse: "Created folder gate-test."
    });

    await useChatStore.getState().sendMessageStream("create a folder called gate-test");

    expect(mocks.runAuthorizedGoal).toHaveBeenCalledTimes(1);
    const [chatId, text] = mocks.runAuthorizedGoal.mock.calls[0];
    expect(chatId).toBe("chat-gate");
    expect(text).toBe("create a folder called gate-test");
    expect(lastMessage()?.content).toBe("Created folder gate-test.");
    expect(sendStreamMock).not.toHaveBeenCalled();
  });

  it("still streams normal chat while the terminal is disconnected", async () => {
    const chat = makeChat("chat-gate");
    await seed(chat);
    sendStreamMock.mockReturnValue(streamOf("Hello there!"));

    await useChatStore.getState().sendMessageStream("hello");

    expect(sendStreamMock).toHaveBeenCalledTimes(1);
    expect(mocks.runAuthorizedGoal).not.toHaveBeenCalled();
    expect(lastMessage()?.content).toBe("Hello there!");
  });
});
