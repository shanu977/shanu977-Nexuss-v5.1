import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChatComposer from "@/components/ChatComposer";

afterEach(() => {
  cleanup();
});

function renderComposer(overrides: {
  onOpenWorkspace?: () => void;
  onStartScreenShare?: () => void;
} = {}) {
  const onSend = vi.fn();
  const onStartScreenShare = overrides.onStartScreenShare ?? vi.fn();
  render(
    <ChatComposer
      onSend={onSend}
      loading={false}
      onOpenWorkspace={overrides.onOpenWorkspace}
      onStartScreenShare={onStartScreenShare}
    />
  );
  return { onSend, onStartScreenShare };
}

describe("ChatComposer Path menu item", () => {
  it("opens the Path workspace panel from the + menu", () => {
    const onOpenWorkspace = vi.fn();
    renderComposer({ onOpenWorkspace });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    const pathItem = screen.getByRole("menuitem", { name: "Path" });
    expect(pathItem).toBeInTheDocument();
    expect(pathItem).not.toBeDisabled();
    expect(pathItem).not.toHaveTextContent("Soon");

    fireEvent.click(pathItem);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps Share Screen working alongside Path", () => {
    const onStartScreenShare = vi.fn();
    renderComposer({ onStartScreenShare });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share Screen" }));
    expect(onStartScreenShare).toHaveBeenCalledTimes(1);
  });

  it("handles an omitted Path callback gracefully", () => {
    renderComposer({ onOpenWorkspace: undefined });

    fireEvent.click(screen.getByLabelText("Add attachment"));
    expect(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Path" }));
    }).not.toThrow();
  });
});