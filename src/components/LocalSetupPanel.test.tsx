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
    disk: vi.fn(),
    connectorStatus: vi.fn(),
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
  activeOllamaPullModel: vi.fn(() => null),
  isPullCancelled: (e: unknown) =>
    e instanceof Error && (e.name === "PullCancelledError" || e.name === "AbortError"),
  timeoutFetch: vi.fn(),
  streamLocalChat: vi.fn(async function* () {}),
  // chatStore's pre-flight Ollama ensure — default to "already verified" so
  // these component tests never touch a connector or spawn Ollama.
  ensureLocalModelConnection: vi.fn(async () => ({ ok: true, via: "skipped", alreadyRunning: true })),
  isLocalConnectionError: (e: unknown) => e instanceof Error && e.name === "LocalConnectionError",
  LocalConnectionError: class LocalConnectionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LocalConnectionError";
    }
  },
}));

vi.mock("@/services/ollamaSetup", () => ({
  detectOllamaSetup: mocks.detect,
  fetchConnectorDiskInfo: mocks.disk,
  fetchConnectorOllamaStatus: mocks.connectorStatus,
  verifyLocalChat: mocks.verify,
  friendlySetupError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  unknownReasonCopy: () => "We couldn't check your device.",
  CONNECTOR_BASE: "http://127.0.0.1:11435"
}));

vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue({ provider: "groq", model: "openai/gpt-oss-120b", theme: "dark" }),
    update: vi.fn().mockResolvedValue({})
  }
}));
vi.mock("@/services/account", () => ({
  getAccountInfo: vi.fn(),
  fetchServerExport: vi.fn(),
  downloadJson: vi.fn(),
  getDeletionStatus: vi.fn(),
  getReauthMethod: vi.fn(),
  DELETION_STAGE_LABELS: {}
}));
vi.mock("@/services/accountData", () => ({
  gatherLocalAccountExport: vi.fn(),
  purgeLocalAccountData: vi.fn()
}));
vi.mock("@/workspace/store", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ workspace: { name: "Test Workspace", root: "/tmp/x" } })
  )
}));

const GB = 1024 ** 3;
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

function setStorageEstimate(quota: number, usage = 0) {
  Object.defineProperty(navigator, "storage", {
    value: { estimate: async () => ({ quota, usage }) },
    configurable: true
  });
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

function renderPanel(props: Partial<LocalSetupPanelProps> = {}) {
  return render(
    <LocalSetupPanel
      entry={props.entry}
      onClose={props.onClose ?? vi.fn()}
      onAdvanced={props.onAdvanced ?? vi.fn()}
      onProviderReady={props.onProviderReady}
    />
  );
}

/** Open on the device checks and wait for the detection to settle. */
async function renderChecks() {
  renderPanel({ entry: "check" });
  await waitFor(
    () => expect(screen.queryByTestId("setup-detecting")).not.toBeInTheDocument(),
    OPT
  );
}

/**
 * Walk the wizard from the check step to the confirm screen. The chooser
 * auto-selects the recommendation, so no model choice is needed here.
 */
async function goToConfirm() {
  const continueBtn = screen.queryByTestId("setup-continue");
  if (continueBtn) {
    fireEvent.click(continueBtn);
  } else {
    fireEvent.click(await screen.findByTestId("setup-choose-instead", undefined, OPT));
  }
  await screen.findByTestId("setup-choose", undefined, OPT);
  fireEvent.click(await screen.findByTestId("setup-choose-continue", undefined, OPT));
  await screen.findByTestId("setup-confirm", undefined, OPT);
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
  setStorageEstimate(64 * GB);
  mocks.detect.mockReset();
  mocks.verify.mockReset();
  mocks.discover.mockReset();
  mocks.pull.mockReset();
  mocks.cancelPull.mockReset();
  mocks.disk.mockReset();
  mocks.connectorStatus.mockReset();
  mocks.detect.mockResolvedValue({ state: "unknown", reason: "connector_unreachable", via: "direct" });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.discover.mockResolvedValue({ models: [], endpointReachable: true });
  mocks.disk.mockResolvedValue({ freeBytes: 100 * GB, totalBytes: 512 * GB });
  mocks.connectorStatus.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe("LocalSetupPanel — device checks", () => {
  it("probes the default Ollama endpoint and reports a reachable provider", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });

    await renderChecks();

    expect(mocks.detect).toHaveBeenCalledWith({ endpoint: DEFAULT_ENDPOINT });
    expect(screen.getByTestId("setup-check")).toBeInTheDocument();
    expect(screen.getByText("Ollama found and responding")).toBeInTheDocument();
    // Device + storage facts are shown before anything is downloaded.
    expect(screen.getByTestId("setup-device-info")).toBeInTheDocument();
    expect(screen.getByTestId("setup-storage-summary")).toBeInTheDocument();
    expect(screen.getByTestId("setup-continue")).toBeEnabled();
  });

  it("lists installed models with real measured sizes", async () => {
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

    await renderChecks();

    // Measured size comes from the provider, not a hardcoded number.
    expect(screen.getByText(/1 model • 4\.9 GB \(measured\)/)).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("setup-choose-instead", undefined, OPT));
    await screen.findByTestId("setup-choose", undefined, OPT);

    const options = within(screen.getByTestId("setup-options")).getAllByRole("radio");
    expect(options.length).toBeLessThanOrEqual(3);
    const llama = screen.getByTestId("setup-option-llama3.1:8b");
    expect(llama).toHaveTextContent("Llama 3.1 8B");
    expect(llama).toHaveTextContent("Installed");
    expect(llama).toHaveTextContent("8B");
  });

  it("recommends an installed model based on actual hardware", async () => {
    setDeviceMemory(4);
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [
        installed("qwen2.5:0.5b", { parameterSize: "0.5B", size: 400 * 1024 ** 2 }),
        installed("phi3:latest", { parameterSize: "3.8B", size: 2.3 * GB }),
        installed("llama3.1:8b", { parameterSize: "8.0B", size: 4.9 * GB })
      ]
    });

    await renderChecks();
    fireEvent.click(await screen.findByTestId("setup-choose-instead", undefined, OPT));
    await screen.findByTestId("setup-choose", undefined, OPT);

    const label = (await screen.findByText("Qwen 2.5 0.5B")).closest("label");
    expect(within(label as HTMLElement).getByTestId("setup-recommended-badge")).toBeInTheDocument();
    expect(screen.getAllByRole("radio").length).toBeLessThanOrEqual(3);
  });

  it("offers a hardware-aware download when Ollama runs without models", async () => {
    setDeviceMemory(8);
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });

    await renderChecks();
    fireEvent.click(screen.getByTestId("setup-continue"));
    await screen.findByTestId("setup-choose", undefined, OPT);

    // Exactly the compact chooser: at most three recommendations.
    expect(screen.getAllByRole("radio").length).toBeLessThanOrEqual(3);
    expect(screen.getByTestId("setup-option-qwen2.5:3b")).toHaveTextContent("Recommended");

    fireEvent.click(screen.getByTestId("setup-choose-continue"));
    await screen.findByTestId("setup-confirm", undefined, OPT);

    expect(screen.getByText("Ready to install local AI?")).toBeInTheDocument();
    expect(screen.getByText(/Qwen 2\.5 3B \(qwen2\.5:3b\)/)).toBeInTheDocument();
    expect(screen.getByTestId("setup-install-start")).toHaveTextContent("Install and Connect");
  });

  it("shows the install state with the official download link when Ollama is missing", async () => {
    mocks.detect.mockResolvedValue({ state: "not_installed", installed: false, via: "connector" });

    await renderChecks();

    const notice = await screen.findByTestId("setup-provider-notice", undefined, OPT);
    expect(within(notice).getByText("No local AI provider found")).toBeInTheDocument();
    const link = screen.getByTestId("setup-install-link");
    expect(link).toHaveAttribute("href", "https://ollama.com/download");
    expect(link).toHaveAttribute("target", "_blank");
    // Honest: an absent provider is never described as already installed.
    expect(screen.queryByText("Ollama is installed but not running")).toBeNull();
  });

  it("shows the stopped state with a recovery action", async () => {
    mocks.detect.mockResolvedValue({ state: "stopped", installed: true, via: "connector" });

    await renderChecks();

    const notice = await screen.findByTestId("setup-provider-notice", undefined, OPT);
    expect(within(notice).getByText("Ollama is installed but not running")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-connect-existing")).toBeNull();

    fireEvent.click(screen.getByTestId("setup-check-again"));
    await waitFor(() => expect(mocks.detect).toHaveBeenCalledTimes(2), OPT);
  });

  it("classifies a blocked browser probe as unknown — never as not installed", async () => {
    mocks.detect.mockResolvedValue({ state: "unknown", reason: "blocked", via: "direct" });

    await renderChecks();

    const notice = await screen.findByTestId("setup-provider-notice", undefined, OPT);
    expect(within(notice).getByText("We couldn't check your device.")).toBeInTheDocument();
    expect(screen.queryByText(/isn't installed yet/)).toBeNull();
    expect(screen.queryByText("No local AI provider found")).toBeNull();
    expect(screen.getByTestId("setup-check-again")).toBeInTheDocument();
  });

  it("shows a checking state while detection is in flight", async () => {
    mocks.detect.mockReturnValue(new Promise(() => {}));

    renderPanel({ entry: "check" });

    expect(await screen.findByTestId("setup-detecting", undefined, OPT)).toBeInTheDocument();
    expect(screen.getByTestId("setup-phase")).toHaveTextContent("Checking device");
  });

  it("blocks Continue only when the measured disk is definitively too small", async () => {
    setDeviceMemory(8);
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });
    mocks.disk.mockResolvedValue({ freeBytes: 100 * 1024 ** 2, totalBytes: 512 * GB });

    await renderChecks();

    expect(screen.getByTestId("setup-storage-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("setup-continue")).toBeDisabled();
  });

  it("never treats an unreadable disk as zero storage", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });
    mocks.disk.mockResolvedValue(null);

    await renderChecks();

    expect(screen.getByTestId("setup-storage-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-storage-blocked")).toBeNull();
    expect(screen.getByTestId("setup-continue")).toBeEnabled();
  });

  it("hands back to the provider card when the provider is already registered", async () => {
    const onProviderReady = vi.fn();
    mocks.detect.mockResolvedValue({
      state: "models",
      via: "connector",
      models: [installed("qwen3:4b", { parameterSize: "4B" })]
    });
    useLocalModelStore.setState({
      providers: [
        {
          id: "prov-ollama-1",
          userId: "uid-1",
          name: "Ollama",
          providerType: "ollama",
          endpoint: DEFAULT_ENDPOINT,
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });

    renderPanel({ entry: "check", onProviderReady });
    await waitFor(
      () => expect(screen.queryByTestId("setup-detecting")).not.toBeInTheDocument(),
      OPT
    );

    expect(await screen.findByTestId("setup-already-connected", undefined, OPT)).toBeInTheDocument();
    expect(screen.queryByTestId("setup-install-steps")).toBeNull();
    fireEvent.click(screen.getByTestId("setup-open-card"));
    expect(onProviderReady).toHaveBeenCalled();
  });
});

describe("LocalSetupPanel — download, connect, verify", () => {
  it("downloads the recommended model with real progress, then connects and verifies", async () => {
    setDeviceMemory(8);
    mocks.detect
      .mockResolvedValueOnce({ state: "no_models", via: "connector" })
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

    await renderChecks();
    await goToConfirm();
    fireEvent.click(screen.getByTestId("setup-install-start"));

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
    const modelSelect = (await screen.findByLabelText("Model", undefined, OPT)) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("qwen2.5:3b"), OPT);
    expect(within(modelSelect).getByRole("option", { name: "qwen2.5:3b" })).toBeInTheDocument();
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

    await renderChecks();
    await goToConfirm();
    fireEvent.click(screen.getByTestId("setup-install-start"));

    await screen.findByTestId("setup-download-progress", undefined, OPT);
    fireEvent.click(screen.getByTestId("setup-cancel-download"));

    await screen.findByTestId("setup-download-cancelled", undefined, OPT);
    expect(mocks.cancelPull).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(screen.queryByTestId("setup-failure")).toBeNull();
  });

  it("keeps the download running when the panel is closed and restores it on reopen", async () => {
    mocks.detect
      .mockResolvedValueOnce({ state: "no_models", via: "connector" })
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

    const view = renderPanel({ entry: "check" });
    await waitFor(
      () => expect(screen.queryByTestId("setup-detecting")).not.toBeInTheDocument(),
      OPT
    );
    await goToConfirm();
    fireEvent.click(screen.getByTestId("setup-install-start"));
    await screen.findByTestId("setup-download-progress", undefined, OPT);
    view.unmount();

    // Reopen: the store-level task restores live progress.
    renderPanel({ entry: "check" });
    await screen.findByTestId("setup-install", undefined, OPT);
    expect(screen.getByText("20%")).toBeInTheDocument();

    release();
    await screen.findByTestId("setup-ready", undefined, OPT);
  });

  it("deduplicates rapid double-clicks on Install and Connect", async () => {
    mocks.detect.mockResolvedValue({ state: "no_models", via: "connector" });
    let release!: () => void;
    mocks.pull.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    await renderChecks();
    await goToConfirm();

    const button = screen.getByTestId("setup-install-start");
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

    await renderChecks();

    fireEvent.click(await screen.findByTestId("setup-connect", undefined, OPT));

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

    await renderChecks();

    fireEvent.click(await screen.findByTestId("setup-connect", undefined, OPT));

    const alert = await screen.findByTestId("setup-connect-error", undefined, OPT);
    expect(alert).toHaveTextContent("The model did not reply.");
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

    await renderChecks();

    fireEvent.click(await screen.findByTestId("setup-connect", undefined, OPT));

    const alert = await screen.findByTestId("setup-connect-error", undefined, OPT);
    expect(alert).toHaveTextContent(/Couldn't reach Ollama/);
    expect(screen.queryByTestId("setup-ready")).toBeNull();
    expect(screen.queryByTestId("setup-install-steps")).toBeNull();
  });

  it("offers Advanced configuration from the intro and failure states", async () => {
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

    renderPanel({ entry: "check" });

    await screen.findByTestId("setup-install", undefined, OPT);
    expect(screen.getByText("60%")).toBeInTheDocument();
    // The panel resumed the running task instead of starting a second one.
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.detect).not.toHaveBeenCalled();

    release();
    await pullPromise;
    await screen.findByTestId("setup-ready", undefined, OPT);
  });
});
