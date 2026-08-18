import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const current = {
    user: { uid: "user-a", email: "alice@nexuss.in" },
    signOut: vi.fn().mockResolvedValue(undefined)
  };
  return {
    authStoreMock: {
      state: current,
      // Callable hook (Sidebar uses `useAuthStore((s) => s.user)`) and the
      // getState/setState surface the chat store relies on.
      useAuthStore: Object.assign(
        (selector: (state: unknown) => unknown) =>
          selector(mocks.authStoreMock.state),
        { getState: () => mocks.authStoreMock.state, setState: () => {} }
      )
    },
    signOutMock: current.signOut
  };
});

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: mocks.authStoreMock.useAuthStore
}));

vi.mock("@/services/chat", () => ({
  chatService: { sendStream: vi.fn() }
}));

vi.mock("@/services/settings", () => ({
  settingsService: { get: vi.fn(), update: vi.fn() }
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Sidebar from "@/components/Sidebar";
import { useChatStore } from "@/store";
import db from "@/lib/db/db";

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.clear();
    await db.messages.clear();
  });
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
    fallbackNotice: null,
    theme: "light"
  });
  mocks.signOutMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSidebar() {
  return render(<Sidebar isOpen onClose={() => {}} />);
}

describe("Sidebar footer actions", () => {
  it("shows Settings and Log out as permanent actions alongside the profile", () => {
    renderSidebar();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
    expect(screen.getByText("alice@nexuss.in")).toBeInTheDocument();
  });

  it("calls the existing signOut flow when Log out is clicked", () => {
    renderSidebar();
    fireEvent.click(screen.getByText("Log out"));
    expect(mocks.signOutMock).toHaveBeenCalledTimes(1);
  });

  it("opens the existing Settings modal when Settings is clicked", () => {
    renderSidebar();
    expect(screen.queryByText("SETTINGS")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Settings"));
    expect(screen.getByText("SETTINGS")).toBeInTheDocument();
  });
});