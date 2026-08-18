import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import MessageList from "@/components/MessageList";
import { useChatStore } from "@/store";
import { Message } from "@/types/chats";
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

function makeMessage(
  id: string,
  chatId: string,
  role: "user" | "assistant",
  content: string
): Message {
  return { id, chatId, role, content, timestamp: 1 };
}

beforeEach(async () => {
  // jsdom does not implement scrollIntoView; stub it so the auto-scroll effect
  // on message changes does not throw.
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.clear();
    await db.messages.clear();
  });
  setMockUser(UID);
  useChatStore.setState({
    currentChat: { id: "c1", userId: UID, title: "T", provider: "groq", createdAt: 1, updatedAt: 1 },
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
});

afterEach(() => {
  cleanup();
});

function renderList(props: {
  messages: Message[];
  loading?: boolean;
  isStreaming?: boolean;
  streamingMessageId?: string | null;
}) {
  return render(
    <MessageList
      messages={props.messages}
      loading={props.loading ?? false}
      isStreaming={props.isStreaming ?? false}
      streamingMessageId={props.streamingMessageId ?? null}
    />
  );
}

describe("MessageList streaming", () => {
  it("renders the assistant reply in place with a cursor while it streams", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "Hooks let you use state.");

    const { container } = renderList({
      messages: [userMsg, asstMsg],
      loading: true,
      isStreaming: true,
      streamingMessageId: "a1"
    });

    // The in-place message (not a separate streaming bubble) shows the answer.
    expect(screen.getByText("Hooks let you use state.")).toBeInTheDocument();
    expect(screen.getByText("Explain hooks")).toBeInTheDocument();

    // No "thinking" indicator is shown while content is streaming in.
    expect(screen.queryByText("Nexuss is thinking...")).not.toBeInTheDocument();

    // The streaming message carries the blinking cursor.
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).not.toBeNull();
  });

  it("does not show the cursor once streaming has finished", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "Done.");

    const { container } = renderList({
      messages: [userMsg, asstMsg],
      isStreaming: false,
      streamingMessageId: null
    });

    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("shows the thinking indicator only while waiting before streaming begins", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");

    renderList({
      messages: [userMsg],
      loading: true,
      isStreaming: false,
      streamingMessageId: null
    });

    expect(screen.getByText("Nexuss is thinking...")).toBeInTheDocument();
  });

  it("shows the thinking indicator inside the streaming assistant message until the first chunk", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "");

    const { container } = renderList({
      messages: [userMsg, asstMsg],
      loading: true,
      isStreaming: true,
      streamingMessageId: "a1"
    });

    // The empty streaming message shows the thinking indicator in place; no
    // blinking cursor yet because no content has arrived.
    expect(screen.getByText("Nexuss is thinking...")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});
