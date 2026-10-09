import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import LocalSetupPanel, { type LocalSetupPanelProps } from "@/components/LocalSetupPanel";
import ModelsSettings from "@/components/ModelsSettings";
import { useLocalModelStore } from "@/store/localModelStore";
import { useChatStore } from "@/store";
import db from "@/lib/db/db";
import { DEFAULT_PROVIDER_MODELS } from "@/types/providers";

const mocks = vi.hoisted(() => {
  const auth = { user: { uid: "uid-1" } as { uid: string } | null };
  const useAuthStore = Object.assign(
    (selector: (s: typeof auth) => unknown) => selector(auth),
    {
      getState: () => auth,
      setState: vi.fn(),
      subscribe: () => () => {}
    }
  );
  return {
    detect: vi.fn(),
    verify: vi.fn(),
    discover: vi.fn(),
    pull: vi.fn(),
    cancelPull: vi.fn(),
    useAuthStore
  };
});

vi.mock("@/store/useAuthStore", () => ({ useAuthStore: mocks.useAuthStore }));

// In-memory db: fake-indexeddb wedges when a dangling write overlaps the
// next test's clear transaction, hanging otherwise-passing connect tests.
vi.mock("@/lib/db/db", async () => {
  const { createMemoryDb } = await import("@/test/memoryDb");
  return { default: createMemoryDb() };
});

vi.mock("@/services/localModels", () => ({
  testLocalEndpoint: vi.fn(async () => ({
    ok: true,
    message: "Connected.",
    models: [] as string[],
    endpointReachable: true,
    modelsDiscoverable: true
  })),
  discoverLocalModels: vi.fn(async () => [] as string[]),
  discoverOllamaModelsDetailed: mocks.discover,
  pullOllamaModel: mocks.pull,
  cancelOllamaPull: mocks.cancelPull,
  isPullCancelled: (e: unknown) =>
    e instanceof Error && (e.name === "PullCancelledError" || e.name === "AbortError"),
  timeoutFetch: vi.fn(),
  streamLocalChat: vi.fn(async function* () {})
}));

vi.mock("@/services/ollamaSetup", () => ({
  detectOllamaSetup: mocks.detect,
  verifyLocalChat: mocks.verify,
  friendlySetupError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  unknownReasonCopy: () => "We couldn't check your device.",
  CONNECTOR_BASE: "http://127.0.0.1:11435"
}));

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const OPT = { timeout: 20000 };
// Connect-flow tests await detect + refresh + verify + select end-to-end;
// under parallel load that can exceed vitest's 5s default test timeout.
vi.setConfig({ testTimeout: 20000 });

function setDeviceMemory(gb?: number) {
  if (gb == null) {
    delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return;
  }
  Object.defineProperty(navigator, "deviceMemory", { value: gb, configurable: true });
}

function seedEmptyStore() {
  useLocalModelStore.setState({
    hydrated: true,
    providers: [],
    models: [],
    discoveredOllamaModels: [],
    ollamaStatus: "not_connected",
    ollamaError: null,
    ollamaLastRefresh: null,
    ollamaPullProgress: null,
    ollamaPullTask: null
  });
}

function installed(id: string, extra: Record<string, unknown> = {}) {
  return { id, modelId: id, ...extra };
}

/** The Connect button is disabled until the auto-selection effect picks a model. */
async function clickConnect() {
  const btn = await screen.findByTestId("setup-connect", undefined, OPT);
  await waitFor(() => expect(btn).toBeEnabled(), OPT);
  fireEvent.click(btn);
}

function renderPanel(props: Partial<LocalSetupPanelProps> = {}) {
  return render(
    <LocalSetupPanel onClose={props.onClose ?? vi.fn()} onAdvanced={props.onAdvanced ?? vi.fn()} />
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction(
    "rw",
    db.localProviders,
    db.localModels,
    db.chats,
    db.messages,
    async () => {
      await db.localProviders.clear();
      await db.localModels.clear();
      await db.chats.clear();
      await db.messages.clear();
    }
  );
  useLocalModelStore.getState().reset();
  seedEmptyStore();
  useChatStore.setState({ provider: "groq", model: DEFAULT_PROVIDER_MODELS.groq });
  setDeviceMemory(undefined);
  mocks.detect.mockReset();
  mocks.verify.mockReset();
  mocks.discover.mockReset();
  mocks.pull.mockReset();
  mocks.cancelPull.mockReset();
  mocks.detect.mockResolvedValue({ state: "unknown", reason: "connector_unreachable", via: "direct" });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.discover.mockResolvedValue({ models: [], endpointReachable: true });
});

afterEach(() => {
  cleanup();
});

describe("LocalSetupPanel — detection states", () => {
  it("probes the default Ollama endpoint and labels the connection as local", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });

    renderPanel();

    expect(await screen.findByTestId("setup-no-models", undefined, OPT)).toBeInTheDocument();
    expect(mocks.detect).toHaveBeenCalledWith({ endpoint: DEFAULT_ENDPOINT });
    expect(screen.getByTestId("setup-endpoint")).toHaveTextContent(DEFAULT_ENDPOINT);
  });

  it("lists installed models with real sizes", async () => {
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [
        installed("llama3.1:8b", {
          size: 5_268_066_377,
          parameterSize: "8.0B",
          quantization: "Q4_K_M"
        })
      ]
    });

    renderPanel();

    await screen.findByTestId("setup-models", undefined, OPT);
    expect(screen.getByRole("radio", { name: /llama3\.1:8b/ })).toBeInTheDocument();
    expect(screen.getByTestId("setup-models-list")).toHaveTextContent("4.9 GB");
    expect(screen.getByTestId("setup-models-list")).toHaveTextContent("8.0B");
  });

  it("recommends an installed model based on actual hardware", async () => {
    setDeviceMemory(4);
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [
        installed("qwen2.5:0.5b", { parameterSize: "0.5B", size: 400 * 1024 ** 2 }),
        installed("phi3:latest", { parameterSize: "3.8B", size: 2.3 * 1024 ** 3 }),
        installed("llama3.1:8b", { parameterSize: "8.0B", size: 4.9 * 1024 ** 3 })
      ]
    });

    renderPanel();

    await screen.findByTestId("setup-models", undefined, OPT);
    const label = (await screen.findByText("qwen2.5:0.5b")).closest("label");
    expect(within(label as HTMLElement).getByTestId("setup-recommended-badge")).toBeInTheDocument();
  });

  it("offers a hardware-aware download when Ollama runs without models", async () => {
    setDeviceMemory(8);
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });

    renderPanel();

    await screen.findByTestId("setup-recommended", undefined, OPT);
    expect(screen.getByTestId("setup-recommended")).toHaveTextContent("Qwen 2.5 3B");
    expect(screen.getByTestId("setup-download-start")).toBeInTheDocument();
  });

  it("shows the install state with the official download link when Ollama is missing", async () => {
    mocks.detect.mockResolvedValue({ state: "not_installed", installed: false, via: "connector" });

    renderPanel();

    await screen.findByTestId("setup-not-installed", undefined, OPT);
    expect(screen.getByText("Ollama isn't installed yet")).toBeInTheDocument();
    const link = screen.getByTestId("setup-install-link");
    expect(link).toHaveAttribute("href", "https://ollama.com/download");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows the stopped state with a recovery action", async () => {
    mocks.detect.mockResolvedValue({ state: "stopped", installed: true, via: "connector" });

    renderPanel();

    await screen.findByTestId("setup-stopped", undefined, OPT);
    expect(screen.getByText("Ollama is installed but not running")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("setup-check-again"));
    await waitFor(() => expect(mocks.detect).toHaveBeenCalledTimes(2), OPT);
  });

  it("classifies a blocked browser probe as unknown — never as not installed", async () => {
    mocks.detect.mockResolvedValue({ state: "unknown", reason: "blocked", via: "direct" });

    renderPanel();

    await screen.findByTestId("setup-unknown", undefined, OPT);
    expect(screen.queryByTestId("setup-not-installed")).toBeNull();
    expect(screen.queryByText(/isn't installed yet/)).toBeNull();
    expect(screen.getByTestId("setup-check-again")).toBeInTheDocument();
  });

  it("shows a checking state while detection is in flight", async () => {
    mocks.detect.mockReturnValue(new Promise(() => {}));

    renderPanel();

    expect(await screen.findByTestId("setup-detecting", undefined, OPT)).toBeInTheDocument();
    expect(screen.getByTestId("setup-phase")).toHaveTextContent("Checking device");
  });
});

describe("LocalSetupPanel — download, connect, verify", () => {
  it("downloads the recommended model with real progress, then connects and verifies", async () => {
    setDeviceMemory(8);
    mocks.detect
      .mockResolvedValueOnce({ state: "no_models", via: "connector" })
      .mockResolvedValue({
        state: "models",
        via: "connector",
        models: [installed("qwen2.5:3b", { parameterSize: "3B", size: 1_900_000_000 })]
      });
    mocks.discover.mockResolvedValue({
      models: [installed("qwen2.5:3b")],
      endpointReachable: true
    });

    let release!: () => void;
    mocks.pull.mockImplementation(
      (id: string, onProgress?: (p: Record<string, unknown>) => void) => {
        onProgress?.({ model: id, status: "pulling manifest" });
        onProgress?.({
          model: id,
          status: "downloading",
          completed: 500,
          total: 1000,
          percent: 50,
          bytesPerSecond: 1024 * 1024
        });
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    );

    renderPanel();

    fireEvent.click(await screen.findByTestId("setup-download-start", undefined, OPT));

    // Real progress from the backend stream — never fake percentages.
    await screen.findByTestId("setup-download-progress", undefined, OPT);
    expect(mocks.pull).toHaveBeenCalledWith("qwen2.5:3b", expect.any(Function));
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByTestId("setup-download-bytes")).toHaveTextContent("500 B / 1000 B");
    expect(screen.getByTestId("setup-download-bytes")).toHaveTextContent("1 MB/s");
    expect(screen.getByTestId("setup-cancel-download")).toBeInTheDocument();

    release();

    await screen.findByTestId("setup-ready", undefined, OPT);
    expect(mocks.verify).toHaveBeenCalledWith(DEFAULT_ENDPOINT, "qwen2.5:3b");
    expect(useChatStore.getState().provider).toBe("local");
    expect(useChatStore.getState().model).toBe("qwen2.5:3b");
    await waitFor(
      () =>
        expect(
          useLocalModelStore.getState().models.some((m) => m.modelId === "qwen2.5:3b")
        ).toBe(true),
      OPT
    );

    // The connected model shows up in the normal provider/model picker.
    render(<ModelsSettings />);
    const providerSelect = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(providerSelect.value).toBe("qwen2.5:3b"), OPT);
    expect(within(providerSelect).getByRole("option", { name: "qwen2.5:3b" })).toBeInTheDocument();
  });

  it("cancels an in-flight download without killing the panel", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });
    mocks.pull.mockImplementation(
      (id: string, onProgress?: (p: Record<string, unknown>) => void) => {
        onProgress?.({ model: id, status: "downloading", completed: 10, total: 100, percent: 10 });
        return new Promise<void>((_, reject) => {
          mocks.cancelPull.mockImplementation(() => {
            const e = new Error("Download cancelled.");
            e.name = "PullCancelledError";
            reject(e);
          });
        });
      }
    );

    renderPanel();

    fireEvent.click(await screen.findByTestId("setup-download-start", undefined, OPT));
    await screen.findByTestId("setup-download-progress", undefined, OPT);
    fireEvent.click(screen.getByTestId("setup-cancel-download"));

    await screen.findByTestId("setup-download-cancelled", undefined, OPT);
    expect(mocks.cancelPull).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
  });

  it("keeps the download running when the panel is closed and restores it on reopen", async () => {
    mocks.detect
      .mockResolvedValueOnce({ state: "no_models", via: "connector" })
      .mockResolvedValue({
        state: "models",
        via: "connector",
        models: [installed("qwen2.5:3b")]
      });
    mocks.discover.mockResolvedValue({ models: [installed("qwen2.5:3b")], endpointReachable: true });

    let release!: () => void;
    mocks.pull.mockImplementation(
      (id: string, onProgress?: (p: Record<string, unknown>) => void) => {
        onProgress?.({
          model: id,
          status: "downloading",
          completed: 200,
          total: 1000,
          percent: 20
        });
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    );

    const { unmount } = renderPanel();
    fireEvent.click(await screen.findByTestId("setup-download-start", undefined, OPT));
    await screen.findByTestId("setup-download-progress", undefined, OPT);
    unmount();

    // Reopen: the store-level task restores live progress.
    renderPanel();
    await screen.findByTestId("setup-download", undefined, OPT);
    expect(screen.getByText("20%")).toBeInTheDocument();

    release();
    await screen.findByTestId("setup-ready", undefined, OPT);
  });

  it("deduplicates rapid double-clicks on Download", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });
    let release!: () => void;
    mocks.pull.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    renderPanel();

    const button = await screen.findByTestId("setup-download-start", undefined, OPT);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1), OPT);

    release();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("connects an installed model through the existing provider store", async () => {
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [installed("qwen3:4b", { parameterSize: "4B" })]
    });
    mocks.discover.mockResolvedValue({ models: [installed("qwen3:4b")], endpointReachable: true });

    renderPanel();

    await clickConnect();

    await screen.findByTestId("setup-ready", undefined, OPT);
    expect(useChatStore.getState().model).toBe("qwen3:4b");
    const st = useLocalModelStore.getState();
    expect(st.providers.some((p) => p.providerType === "ollama" && p.enabled)).toBe(true);
    expect(st.ollamaStatus).toBe("connected");
  });
});

describe("LocalSetupPanel — honesty guards", () => {
  it("never shows Ready when the verification reply fails", async () => {
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [installed("qwen3:4b")]
    });
    mocks.discover.mockResolvedValue({ models: [installed("qwen3:4b")], endpointReachable: true });
    mocks.verify.mockResolvedValue({ ok: false, message: "The model did not reply." });

    renderPanel();

    await clickConnect();

    await screen.findByTestId("setup-failure", undefined, OPT);
    expect(screen.getByRole("alert")).toHaveTextContent("The model did not reply.");
    expect(screen.queryByTestId("setup-ready")).toBeNull();
    // The chat selection is untouched until verification succeeds.
    expect(useChatStore.getState().provider).toBe("groq");
  });

  it("fails loudly when Ollama becomes unreachable during connect", async () => {
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [installed("qwen3:4b")]
    });
    mocks.discover.mockResolvedValue({ models: [], endpointReachable: false });

    renderPanel();

    await clickConnect();

    await screen.findByTestId("setup-failure", undefined, OPT);
    expect(screen.queryByTestId("setup-ready")).toBeNull();
    expect(screen.getByTestId("setup-retry")).toBeInTheDocument();
  });

  it("offers Advanced configuration from every recovery state", async () => {
    const onAdvanced = vi.fn();
    mocks.detect.mockResolvedValue({ state: "unknown", reason: "timeout", via: "connector" });

    renderPanel({ onAdvanced });

    fireEvent.click(await screen.findByTestId("setup-advanced", undefined, OPT));
    expect(onAdvanced).toHaveBeenCalled();
  });

  it("resumes a download that was already running before the panel opened", async () => {
    let release!: () => void;
    mocks.pull.mockImplementation(
      (id: string, onProgress?: (p: Record<string, unknown>) => void) => {
        onProgress?.({ model: id, status: "downloading", completed: 600, total: 1000, percent: 60 });
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    );
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [installed("qwen2.5:3b")]
    });
    mocks.discover.mockResolvedValue({ models: [installed("qwen2.5:3b")], endpointReachable: true });

    // A download started elsewhere (before this panel was opened).
    const pullPromise = useLocalModelStore.getState().pullOllamaModel("qwen2.5:3b");
    await waitFor(
      () => expect(useLocalModelStore.getState().ollamaPullTask?.status).toBe("pulling"),
      OPT
    );

    renderPanel();

    await screen.findByTestId("setup-download", undefined, OPT);
    expect(screen.getByText("60%")).toBeInTheDocument();
    // The panel resumed the running task instead of starting a second one.
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.detect).not.toHaveBeenCalled();

    release();
    await pullPromise;
    await screen.findByTestId("setup-ready", undefined, OPT);
  });
});
