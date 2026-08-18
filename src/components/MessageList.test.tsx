import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

// jsdom does not lay out elements, so give the scroll container fake scroll
// metrics to drive the near-bottom detection used by auto-scrolling.
function mockScrollMetrics(
  el: HTMLElement,
  opts: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: opts.scrollTop
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => opts.scrollHeight
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => opts.clientHeight
  });
}

function scrollContainer(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".overflow-y-auto");
  if (!el) throw new Error("scroll container not found");
  return el as HTMLElement;
}

beforeEach(async () => {
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

  it("wraps markdown tables in a locally scrollable container", () => {
    const asstMsg = makeMessage(
      "a1",
      "c1",
      "assistant",
      "| A | B |\n|---|---|\n| 1 | 2 |"
    );

    const { container } = renderList({
      messages: [asstMsg],
      isStreaming: false,
      streamingMessageId: null
    });

    expect(screen.getByRole("table")).toBeInTheDocument();
    // The <table> must live inside an overflow-x-auto wrapper so wide tables
    // scroll inside the message instead of forcing the page to scroll
    // horizontally on narrow/mobile viewports.
    const table = container.querySelector("table");
    const wrapper = table?.closest(".overflow-x-auto");
    expect(wrapper).not.toBeNull();
  });

  it("breaks long user-message words so they never overflow the viewport", () => {
    const longWord = `https://example.com/${"a".repeat(200)}`;
    const userMsg = makeMessage("u1", "c1", "user", longWord);

    const { container } = renderList({ messages: [userMsg] });

    // The plain user bubble carries the responsive word-break utility.
    expect(container.querySelector("p.break-words")).not.toBeNull();
  });

  it("keeps following the stream while the user is near the bottom", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "First token.");
    const { container, rerender } = renderList({
      messages: [userMsg, asstMsg],
      isStreaming: true,
      streamingMessageId: "a1"
    });

    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollTop: 1990, scrollHeight: 2000, clientHeight: 500 });
    fireEvent.scroll(el);

    const updated = makeMessage("a1", "c1", "assistant", "First token. Second token.");
    rerender(
      <MessageList
        messages={[userMsg, updated]}
        loading={false}
        isStreaming={true}
        streamingMessageId="a1"
      />
    );

    expect(el.scrollTop).toBe(2000);
  });

  it("does not override the scroll position when the user scrolls away mid-stream", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "First token.");
    const { container, rerender } = renderList({
      messages: [userMsg, asstMsg],
      isStreaming: true,
      streamingMessageId: "a1"
    });

    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollTop: 500, scrollHeight: 2000, clientHeight: 500 });
    fireEvent.scroll(el);

    const updated = makeMessage("a1", "c1", "assistant", "First token. Second token.");
    rerender(
      <MessageList
        messages={[userMsg, updated]}
        loading={false}
        isStreaming={true}
        streamingMessageId="a1"
      />
    );

    expect(el.scrollTop).toBe(500);
  });

  it("resumes following once the user returns to the bottom", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Explain hooks");
    const asstMsg = makeMessage("a1", "c1", "assistant", "First token.");
    const { container, rerender } = renderList({
      messages: [userMsg, asstMsg],
      isStreaming: true,
      streamingMessageId: "a1"
    });

    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollTop: 500, scrollHeight: 2000, clientHeight: 500 });
    fireEvent.scroll(el);

    el.scrollTop = 1990;
    fireEvent.scroll(el);

    const updated = makeMessage("a1", "c1", "assistant", "First token. Second token.");
    rerender(
      <MessageList
        messages={[userMsg, updated]}
        loading={false}
        isStreaming={true}
        streamingMessageId="a1"
      />
    );

    expect(el.scrollTop).toBe(2000);
  });

  it("scrolls to the bottom when a new message arrives while near the bottom", () => {
    const userMsg = makeMessage("u1", "c1", "user", "Hi");
    const { container, rerender } = renderList({ messages: [userMsg] });

    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollTop: 1990, scrollHeight: 2000, clientHeight: 500 });
    fireEvent.scroll(el);

    const asstMsg = makeMessage("a1", "c1", "assistant", "Hello!");
    rerender(
      <MessageList
        messages={[userMsg, asstMsg]}
        loading={false}
        isStreaming={false}
        streamingMessageId={null}
      />
    );

    expect(el.scrollTop).toBe(2000);
  });
});
