import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import MessageList from "@/components/MessageList";
import { Message } from "@/types/chats";
import { useWorkspaceStore } from "@/workspace/store";
import { TERMINAL_CONNECT_REQUIRED_MESSAGE } from "@/workspace/terminalConnection";

function makeMessage(role: "user" | "assistant", content: string): Message {
  return { id: `m-${role}-${content.length}`, chatId: "chat-1", role, content, timestamp: 1 };
}

function renderList(messages: Message[]) {
  return render(
    <MessageList
      messages={messages}
      loading={false}
      isStreaming={false}
      streamingMessageId={null}
    />
  );
}

beforeEach(() => {
  useWorkspaceStore.setState({ panelOpen: false });
});

afterEach(() => {
  cleanup();
});

describe("MessageList terminal connect card", () => {
  it("renders the Terminal access required card for the marker message", () => {
    renderList([makeMessage("assistant", TERMINAL_CONNECT_REQUIRED_MESSAGE)]);

    expect(screen.getByText("Terminal access required")).toBeInTheDocument();
    expect(
      screen.getByText("This task requires access to your computer's terminal.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect Terminal/ })).toBeInTheDocument();
  });

  it("opens the Terminal panel when Connect Terminal is clicked", () => {
    renderList([makeMessage("assistant", TERMINAL_CONNECT_REQUIRED_MESSAGE)]);

    fireEvent.click(screen.getByRole("button", { name: /Connect Terminal/ }));

    expect(useWorkspaceStore.getState().panelOpen).toBe(true);
  });

  it("does not render the card for normal assistant content", () => {
    renderList([makeMessage("assistant", "Here is the answer you asked for.")]);

    expect(screen.queryByText("Terminal access required")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect Terminal/ })).not.toBeInTheDocument();
    expect(screen.getByText("Here is the answer you asked for.")).toBeInTheDocument();
  });
});
