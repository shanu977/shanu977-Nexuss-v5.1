import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import ChatComposer from "@/components/ChatComposer";
import { useChatStore } from "@/store";
import { PROVIDER_MODEL_OPTIONS, type ProviderType } from "@/types/providers";
import { settingsService } from "@/services/settings";

vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue({})
  }
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(settingsService.update).mockClear();
  useChatStore.setState({
    provider: "groq",
    model: "openai/gpt-oss-120b",
    fallbackNotice: null
  });
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

describe("ChatComposer model selector", () => {
  const CLOUD_PROVIDERS: ProviderType[] = ["groq", "gemini", "openrouter"];

  function openMenu() {
    const pill = screen.getByTitle("Select model");
    fireEvent.click(pill);
    return pill;
  }

  it("opens the model menu from the pill and lists the configured providers and models", () => {
    renderComposer();
    const pill = screen.getByTitle("Select model");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveTextContent("Groq");
    expect(pill).toHaveTextContent("GPT-OSS 120B");

    openMenu();

    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Choose model" })).toBeInTheDocument();

    for (const p of CLOUD_PROVIDERS) {
      expect(screen.getByText(p === "groq" ? "Groq" : p === "gemini" ? "Gemini" : "OpenRouter")).toBeInTheDocument();
    }

    const options = screen.getAllByRole("option");
    const catalogSize = CLOUD_PROVIDERS.reduce(
      (n, p) => n + PROVIDER_MODEL_OPTIONS[p as Exclude<ProviderType, "local">].length,
      0
    );
    expect(options.length).toBeGreaterThanOrEqual(catalogSize);
    expect(
      screen.getByRole("option", { name: /Gemini 2\.5 Pro/ })
    ).toBeInTheDocument();

    const selected = options.filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("GPT-OSS 120B");
  });

  it("selecting a model updates the pill, the shared chat store, Settings sync, and closes the menu", () => {
    renderComposer();
    openMenu();

    fireEvent.click(screen.getByRole("option", { name: /Gemini 2\.5 Pro/ }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    const cs = useChatStore.getState();
    expect(cs.provider).toBe("gemini");
    expect(cs.model).toBe("gemini-2.5-pro");

    const pill = screen.getByTitle("Select model");
    expect(pill).toHaveTextContent("Gemini");
    expect(pill).toHaveTextContent("Gemini 2.5 Pro");

    expect(settingsService.update).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini" })
    );
    expect(settingsService.update).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-2.5-pro" })
    );
  });

  it("reflects a Settings-driven store change in the pill (same source of truth)", () => {
    renderComposer();

    act(() => {
      useChatStore.getState().setProvider("openrouter");
      useChatStore.getState().setModel("openrouter/free");
    });

    const pill = screen.getByTitle("Select model");
    expect(pill).toHaveTextContent("OpenRouter");
    expect(pill).toHaveTextContent("OpenRouter Free Router");
  });

  it("closes the menu when clicking outside", () => {
    renderComposer();
    openMenu();
    expect(screen.getByRole("listbox", { name: "Choose model" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("cannot open the menu while a response is streaming", () => {
    render(
      <ChatComposer onSend={vi.fn()} onStop={vi.fn()} loading={true} />
    );
    const pill = screen.getByTitle("Select model");
    expect(pill).toBeDisabled();
    fireEvent.click(pill);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});