import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ModelsSettings from "@/components/ModelsSettings";
import SettingsContent from "@/components/SettingsContent";
import { useLocalModelStore } from "@/store/localModelStore";
import { useChatStore } from "@/store";
import db from "@/lib/db/db";
import { DEFAULT_PROVIDER_MODELS } from "@/types/providers";

const mocks = vi.hoisted(() => {
  const auth = { user: null as { uid: string } | null };
  const useAuthStore = Object.assign(
    (selector: (s: typeof auth) => unknown) => selector(auth),
    {
      getState: () => auth,
      setState: vi.fn(),
      subscribe: () => () => {}
    }
  );
  return {
    discover: vi.fn(),
    testLocalEndpoint: vi.fn(),
    useAuthStore,
    setUid: (uid: string | null) => {
      auth.user = uid ? { uid } : null;
    }
  };
});

vi.mock("@/services/localModels", () => ({
  testLocalEndpoint: mocks.testLocalEndpoint,
  discoverLocalModels: vi.fn(async () => [] as string[]),
  discoverOllamaModelsDetailed: mocks.discover,
  pullOllamaModel: vi.fn(async () => undefined),
  streamLocalChat: vi.fn(async function* () {})
}));
vi.mock("@/store/useAuthStore", () => ({ useAuthStore: mocks.useAuthStore }));
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

const OLLAMA_PROVIDER_ID = "prov-ollama-1";

interface SeedModel {
  modelId: string;
  family?: string;
  parameterSize?: string;
  size?: number;
}

function discovered(m: SeedModel) {
  return {
    id: `disc-${m.modelId}`,
    modelId: m.modelId,
    family: m.family,
    parameterSize: m.parameterSize,
    size: m.size
  };
}

/** Seed the local store exactly as a working Ollama connection would leave it. */
function seedOllama(options: {
  status: "connected" | "not_connected" | "error";
  discovered: SeedModel[];
  persisted?: SeedModel[];
}) {
  useLocalModelStore.setState({
    hydrated: true,
    providers: [
      {
        id: OLLAMA_PROVIDER_ID,
        userId: "uid-1",
        name: "Ollama",
        providerType: "ollama",
        endpoint: "http://localhost:11434/v1",
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    models: (options.persisted ?? []).map((m) => ({
      id: `lm-${m.modelId}`,
      userId: "uid-1",
      providerId: OLLAMA_PROVIDER_ID,
      modelId: m.modelId,
      displayName: m.modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      family: m.family,
      parameterSize: m.parameterSize,
      size: m.size
    })),
    discoveredOllamaModels: options.discovered.map(discovered),
    ollamaStatus: options.status,
    ollamaError: null,
    ollamaLastRefresh: Date.now(),
    ollamaPullProgress: null
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  mocks.setUid("uid-1");
  await db.transaction(
    "rw",
    db.chats,
    db.messages,
    db.usageRecords,
    db.localProviders,
    db.localModels,
    async () => {
      await db.chats.clear();
      await db.messages.clear();
      await db.usageRecords.clear();
      await db.localProviders.clear();
      await db.localModels.clear();
    }
  );
  useLocalModelStore.getState().reset();
  useChatStore.setState({ provider: "groq", model: DEFAULT_PROVIDER_MODELS.groq });
  mocks.discover.mockResolvedValue({ models: [], endpointReachable: true });
  mocks.testLocalEndpoint.mockResolvedValue({
    ok: true,
    message: "Connected.",
    models: [],
    endpointReachable: true,
    modelsDiscoverable: true
  });
});

afterEach(() => {
  cleanup();
});

describe("ModelsSettings — local providers as a first-class provider", () => {
  it("shows Ollama in the provider dropdown with its discovered models", async () => {
    const installed: SeedModel[] = [
      { modelId: "qwen2.5-coder:7b", family: "qwen3", parameterSize: "7.6B", size: 5_000_000_000 },
      { modelId: "llama3.3:latest", family: "llama", parameterSize: "8.0B", size: 4_000_000_000 }
    ];
    seedOllama({ status: "connected", discovered: installed });
    mocks.discover.mockResolvedValue({ models: installed.map(discovered), endpointReachable: true });
    useChatStore.setState({ provider: "local", model: "qwen2.5-coder:7b" });

    render(<ModelsSettings />);

    const providerSelect = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    await waitFor(() => {
      expect(providerSelect.selectedOptions[0]).toHaveTextContent("Ollama • Connected");
    });
    expect(
      within(providerSelect).getByRole("option", { name: "Groq" })
    ).toBeInTheDocument();
    expect(
      within(providerSelect).getByRole("option", { name: "Ollama • Connected" })
    ).toBeInTheDocument();

    const modelSelect = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => {
      expect(modelSelect.value).toBe("qwen2.5-coder:7b");
    });
    const optionLabels = within(modelSelect)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(optionLabels).toContain("qwen2.5-coder:7b");
    expect(optionLabels).toContain("llama3.3:latest");
    // Metadata stays secondary: it is not part of the closed dropdown value.
    expect(screen.getByTestId("selected-model-meta")).toHaveTextContent(
      "qwen3 • 7.6B • 5.0 GB disk"
    );
  });

  it("selecting a discovered local model updates the existing selected-model state", async () => {
    const installed: SeedModel[] = [
      { modelId: "qwen2.5-coder:7b", family: "qwen3", parameterSize: "7.6B" },
      { modelId: "llama3.3:latest", family: "llama", parameterSize: "8.0B" }
    ];
    seedOllama({ status: "connected", discovered: installed, persisted: [installed[0]] });
    mocks.discover.mockResolvedValue({ models: installed.map(discovered), endpointReachable: true });
    useChatStore.setState({ provider: "local", model: "qwen2.5-coder:7b" });

    render(<ModelsSettings />);

    const modelSelect = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("qwen2.5-coder:7b"));

    fireEvent.change(modelSelect, { target: { value: "llama3.3:latest" } });

    await waitFor(() => {
      expect(useChatStore.getState().provider).toBe("local");
      expect(useChatStore.getState().model).toBe("llama3.3:latest");
    });
    // The selection is persisted so it survives reopening the panel.
    await waitFor(() => {
      expect(
        useLocalModelStore.getState().models.some((m) => m.modelId === "llama3.3:latest")
      ).toBe(true);
    });
  });

  it("switches the chat provider when a local provider is chosen in the dropdown", async () => {
    const installed: SeedModel[] = [{ modelId: "qwen3:4b", family: "qwen3", parameterSize: "4B" }];
    seedOllama({ status: "connected", discovered: installed });
    mocks.discover.mockResolvedValue({ models: installed.map(discovered), endpointReachable: true });

    render(<ModelsSettings />);

    const providerSelect = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    expect(providerSelect.value).toBe("groq");

    fireEvent.change(providerSelect, { target: { value: `local:${OLLAMA_PROVIDER_ID}` } });

    await waitFor(() => {
      expect(useChatStore.getState().provider).toBe("local");
    });
    const modelSelect = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("qwen3:4b"));
  });

  it("refresh updates the model list from the local connector", async () => {
    const first: SeedModel[] = [{ modelId: "qwen3:4b" }];
    const second: SeedModel[] = [...first, { modelId: "phi3:latest" }];
    seedOllama({ status: "connected", discovered: first, persisted: first });
    mocks.discover.mockResolvedValue({ models: first.map(discovered), endpointReachable: true });
    useChatStore.setState({ provider: "local", model: "qwen3:4b" });

    render(<ModelsSettings />);
    const modelSelect = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(modelSelect.value).toBe("qwen3:4b"));
    expect(within(modelSelect).queryByRole("option", { name: "phi3:latest" })).toBeNull();

    mocks.discover.mockResolvedValue({ models: second.map(discovered), endpointReachable: true });
    fireEvent.click(screen.getByRole("button", { name: "Refresh Models" }));

    await waitFor(() => {
      expect(
        within(modelSelect).getByRole("option", { name: "phi3:latest" })
      ).toBeInTheDocument();
    });
  });

  it("renders a disconnected state instead of offering the provider as available", async () => {
    seedOllama({ status: "not_connected", discovered: [] });
    mocks.discover.mockResolvedValue({ models: [], endpointReachable: false });
    useChatStore.setState({ provider: "local", model: "" });

    render(<ModelsSettings />);

    const providerSelect = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    await waitFor(() => {
      expect(providerSelect.selectedOptions[0]).toHaveTextContent("Ollama • Disconnected");
    });

    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("No local models found")).not.toBeInTheDocument();
  });

  it("renders a clean empty state when Ollama is connected but has no models", async () => {
    seedOllama({ status: "connected", discovered: [] });
    mocks.discover.mockResolvedValue({ models: [], endpointReachable: true });
    useChatStore.setState({ provider: "local", model: "" });

    render(<ModelsSettings />);

    expect(await screen.findByText("No local models found")).toBeInTheDocument();
    expect(
      screen.getByText("Install a model in Ollama, then refresh.")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh Models" })
    ).toBeInTheDocument();
  });
});

describe("Settings → Models tab", () => {
  it("renders the Provider/Model picker and local provider management", async () => {
    const installed: SeedModel[] = [{ modelId: "qwen3:4b", family: "qwen3", parameterSize: "4B" }];
    seedOllama({ status: "connected", discovered: installed });
    mocks.discover.mockResolvedValue({ models: installed.map(discovered), endpointReachable: true });
    useChatStore.setState({ provider: "local", model: "qwen3:4b" });

    render(<SettingsContent initialTab="models" />);

    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Models" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local Providers" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ Add Local Provider" })
    ).toBeInTheDocument();
    // The local connection flow is preserved, just no longer the primary UI.
    expect(screen.queryByText("Local Models")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
  });
});
