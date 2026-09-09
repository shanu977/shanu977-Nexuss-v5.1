import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChatComposer from "@/components/ChatComposer";

afterEach(() => {
  cleanup();
});

function renderComposer(overrides: {
  onOpenWorkspace?: () => void;
  onStartScreenShare?: () => void;
  loading?: boolean;
  disabled?: boolean;
  onStop?: () => void;
} = {}) {
  const onSend = vi.fn();
  const onStartScreenShare = overrides.onStartScreenShare ?? vi.fn();
  const onStop = overrides.onStop ?? vi.fn();
  render(
    <ChatComposer
      onSend={onSend}
      onStop={onStop}
      loading={overrides.loading ?? false}
      disabled={overrides.disabled}
      onOpenWorkspace={overrides.onOpenWorkspace}
      onStartScreenShare={onStartScreenShare}
    />
  );
  return { onSend, onStartScreenShare, onStop };
}

describe("ChatComposer Terminal menu item", () => {
  it("opens the Terminal workspace panel from the + menu", () => {
    const onOpenWorkspace = vi.fn();
    renderComposer({ onOpenWorkspace });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    const pathItem = screen.getByRole("menuitem", { name: "Terminal" });
    expect(pathItem).toBeInTheDocument();
    expect(pathItem).not.toBeDisabled();
    expect(pathItem).not.toHaveTextContent("Soon");

    fireEvent.click(pathItem);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps Share Screen working alongside Terminal", () => {
    const onStartScreenShare = vi.fn();
    renderComposer({ onStartScreenShare });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share Screen" }));
    expect(onStartScreenShare).toHaveBeenCalledTimes(1);
  });

  it("handles an omitted Terminal callback gracefully", () => {
    renderComposer({ onOpenWorkspace: undefined });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    expect(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    }).not.toThrow();
  });
});

describe("ChatComposer Stop button", () => {
  it("shows Send when idle and Stop while generating", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <ChatComposer onSend={vi.fn()} onStop={onStop} loading={false} />
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument();

    rerender(<ChatComposer onSend={vi.fn()} onStop={onStop} loading={true} />);
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("calls onStop when the Stop button is clicked", () => {
    const onStop = vi.fn();
    render(<ChatComposer onSend={vi.fn()} onStop={onStop} loading={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stays clickable while disabled (isStreaming) and does not submit the form", () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <ChatComposer onSend={onSend} onStop={onStop} loading={false} disabled={true} />
    );

    const stop = screen.getByRole("button", { name: "Stop generating" });
    expect(stop).not.toBeDisabled();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});