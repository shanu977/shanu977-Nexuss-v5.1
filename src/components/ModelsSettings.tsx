"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ProviderType } from "@/types";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_MODEL_OPTIONS
} from "@/types/providers";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { useChatStore } from "@/store";
import { useLocalModelStore } from "@/store/localModelStore";
import { selectLocalModel } from "@/services/localModelSelection";
import { testLocalEndpoint } from "@/services/localModels";
import {
  LOCAL_PROVIDER_LABELS,
  LOCAL_PROVIDER_DEFAULT_ENDPOINTS,
  LocalProviderType,
  validateEndpoint,
  normalizeEndpoint,
  isProductionWeb
} from "@/types/localModels";
import { ChevronDownIcon } from "@/components/icons";
import LocalSetupPanel from "@/components/LocalSetupPanel";

const CLOUD_PROVIDERS: ProviderType[] = ["groq", "gemini", "openrouter"];

const LOCAL_PROVIDER_TYPES: LocalProviderType[] = [
  "ollama",
  "lmstudio",
  "vllm",
  "generic"
];

/** Product-facing one-liners shown when picking a provider to connect. */
const PROVIDER_BLURB: Record<LocalProviderType, string> = {
  ollama: "Run AI models locally with Ollama",
  lmstudio: "Connect models running through LM Studio",
  vllm: "Connect a vLLM server",
  generic: "Use a custom OpenAI-compatible local endpoint"
};

/** Provider-aware primary action, e.g. "Connect Ollama". */
const CONNECT_LABEL: Record<LocalProviderType, string> = {
  ollama: "Connect Ollama",
  lmstudio: "Connect LM Studio",
  vllm: "Connect vLLM",
  generic: "Connect"
};

type ConnectionStatus = "connected" | "checking" | "disconnected";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  checking: "Checking…",
  disconnected: "Disconnected"
};

/** Per-card UI state for the Local Providers connection experience. */
type CardState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed"
  | "checking";

interface LocalProviderEntry {
  /** Stable id for the card: persisted row id, "ollama", or "pending:<type>". */
  key: string;
  /** Persisted LocalProvider id, or null when only known through discovery. */
  id: string | null;
  name: string;
  providerType: LocalProviderType;
  endpoint: string;
  enabled: boolean;
  status: ConnectionStatus;
  statusLabel: string;
}

interface ModelOption {
  id: string;
  label: string;
  meta?: string;
}

interface EndpointCheck {
  ok: boolean;
  message: string;
  models: string[];
}

/**
 * Human-readable connection failures. Raw errors (CORS, stack traces, HTTP
 * details) never reach the normal setup flow.
 */
function connectionFailureMessage(type: LocalProviderType): string {
  const name = LOCAL_PROVIDER_LABELS[type];
  if (isProductionWeb()) {
    return `Local AI runs on your own computer, so ${name} can't be reached from the hosted app. Open Nexuss on your computer to connect.`;
  }
  if (type === "generic") {
    return "Couldn't connect to that server. Make sure it's running and try again.";
  }
  return `Couldn't connect to ${name}. Make sure ${name} is running and try again.`;
}

function rejectionMessage(type: LocalProviderType): string {
  return `${LOCAL_PROVIDER_LABELS[type]} responded, but the connection was rejected. Check the address under Advanced connection settings.`;
}

function formatMeta(
  m: { family?: string; parameterSize?: string; size?: number }
): string | undefined {
  const disk = m.size ? `${(m.size / 1e9).toFixed(1)} GB disk` : null;
  const parts = [m.family, m.parameterSize, disk].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

const SELECT_CLASSES =
  "w-full cursor-pointer rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring";

const INPUT_CLASSES =
  "w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring";

const SECONDARY_BUTTON_CLASSES =
  "rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const PRIMARY_BUTTON_CLASSES =
  "rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const CARD_STATUS: Record<
  CardState,
  { label: string; text: string; dot: string }
> = {
  connected: {
    label: "Connected",
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500"
  },
  connecting: {
    label: "Connecting…",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground animate-pulse"
  },
  checking: {
    label: "Checking…",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground animate-pulse"
  },
  failed: {
    label: "Connection failed",
    text: "text-destructive",
    dot: "bg-destructive"
  },
  disconnected: {
    label: "Not connected",
    text: "text-muted-foreground",
    dot: "border border-muted-foreground bg-transparent"
  }
};

function StatusPill({ state }: { state: CardState }) {
  const s = CARD_STATUS[state];
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-[10px] font-medium ${s.text}`}
      data-testid={`local-status-${state}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

interface ProviderChooserProps {
  types: LocalProviderType[];
  onPick: (type: LocalProviderType) => void;
  onCancel: () => void;
}

function ProviderChooser({ types, onPick, onCancel }: ProviderChooserProps) {
  return (
    <div className="space-y-2.5 rounded-xl border border-dashed border-border bg-muted/20 p-3">
      <div>
        <p className="text-xs font-semibold text-foreground">
          Connect a local AI
        </p>
        <p className="text-[11px] text-muted-foreground">
          Choose your local provider:
        </p>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onPick(t)}
            className="rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 cursor-pointer"
          >
            <span className="block text-xs font-semibold text-foreground">
              {LOCAL_PROVIDER_LABELS[t]}
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
              {PROVIDER_BLURB[t]}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );
}

export default function ModelsSettings() {
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);

  // ---- Local providers / models (existing store, unchanged) ----
  const localProviders = useLocalModelStore((s) => s.providers);
  const localModels = useLocalModelStore((s) => s.models);
  const localHydrated = useLocalModelStore((s) => s.hydrated);
  const hydrateLocal = useLocalModelStore((s) => s.hydrate);
  const addLocalProvider = useLocalModelStore((s) => s.addProvider);
  const removeLocalProvider = useLocalModelStore((s) => s.removeProvider);
  const updateLocalProvider = useLocalModelStore((s) => s.updateProvider);
  const addLocalModel = useLocalModelStore((s) => s.addModel);
  const getProviderForModel = useLocalModelStore((s) => s.getProviderForModel);
  const discoveredOllamaModels = useLocalModelStore((s) => s.discoveredOllamaModels);
  const ollamaStatus = useLocalModelStore((s) => s.ollamaStatus);
  const refreshOllamaModels = useLocalModelStore((s) => s.refreshOllamaModels);
  const clearDiscoveredOllamaModels = useLocalModelStore(
    (s) => s.clearDiscoveredOllamaModels
  );

  // ---- Connection flow state (one card per provider) ----
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<Record<string, string>>({});
  const [endpointDrafts, setEndpointDrafts] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});
  const [pendingTypes, setPendingTypes] = useState<LocalProviderType[]>([]);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [endpointChecks, setEndpointChecks] = useState<Record<string, EndpointCheck>>({});
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const [activeLocalKey, setActiveLocalKey] = useState<string | null>(null);

  useEffect(() => {
    if (!localHydrated) void hydrateLocal();
  }, [localHydrated, hydrateLocal]);

  // Refresh an already-connected Ollama as soon as the panel opens. A user who
  // has never connected stays on the chooser — discovery only runs on Connect.
  useEffect(() => {
    if (!localHydrated) return;
    const persisted = useLocalModelStore
      .getState()
      .providers.some((p) => p.providerType === "ollama" && p.enabled);
    if (persisted) void refreshOllamaModels();
  }, [localHydrated, refreshOllamaModels]);

  // Quiet validation of persisted non-Ollama providers so their cards show an
  // accurate Connected / Not connected state after a reload.
  const runCheck = useCallback(
    async (id: string, endpoint: string, type: LocalProviderType, apiKey?: string) => {
      setCheckingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      try {
        const res = await testLocalEndpoint(endpoint, type, apiKey);
        setEndpointChecks((prev) => ({
          ...prev,
          [id]: { ok: res.ok, message: "", models: res.models ?? [] }
        }));
      } catch {
        setEndpointChecks((prev) => ({
          ...prev,
          [id]: { ok: false, message: "", models: [] }
        }));
      } finally {
        setCheckingIds((prev) => prev.filter((x) => x !== id));
      }
    },
    []
  );

  useEffect(() => {
    if (!localHydrated) return;
    for (const p of localProviders) {
      if (p.providerType === "ollama" || !p.enabled) continue;
      if (endpointChecks[p.id] || checkingIds.includes(p.id)) continue;
      void runCheck(p.id, p.endpoint, p.providerType, p.apiKey);
    }
  }, [localHydrated, localProviders, endpointChecks, checkingIds, runCheck]);

  // Keep the selection valid: if the selected Ollama model was deleted, clear it
  // instead of silently switching to another one.
  useEffect(() => {
    if (provider !== "local") return;
    if (ollamaStatus !== "connected" || discoveredOllamaModels.length === 0) return;
    const stillExists =
      discoveredOllamaModels.some((m) => m.modelId === model) ||
      localModels.some((m) => m.modelId === model && m.enabled);
    if (!stillExists && model) setModel("");
  }, [discoveredOllamaModels, localModels, provider, model, ollamaStatus, setModel]);

  const localEntries = useMemo<LocalProviderEntry[]>(() => {
    const entries: LocalProviderEntry[] = [];

    const persistedOllama = localProviders.find((p) => p.providerType === "ollama");
    let ollamaConnection: ConnectionStatus;
    if (persistedOllama && !persistedOllama.enabled) {
      ollamaConnection = "disconnected";
    } else if (ollamaStatus === "connected") {
      ollamaConnection = "connected";
    } else if (ollamaStatus === "not_connected" || ollamaStatus === "error") {
      ollamaConnection = "disconnected";
    } else {
      // "idle" / "loading": only a row we already persisted is worth probing —
      // a fresh provider waits for the user to press Connect.
      ollamaConnection = persistedOllama ? "checking" : "disconnected";
    }
    entries.push({
      key: persistedOllama ? persistedOllama.id : "ollama",
      id: persistedOllama?.id ?? null,
      name: persistedOllama?.name || "Ollama",
      providerType: "ollama",
      endpoint: persistedOllama?.endpoint || LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama,
      enabled: persistedOllama?.enabled ?? true,
      status: ollamaConnection,
      statusLabel:
        persistedOllama && !persistedOllama.enabled
          ? "Disabled"
          : STATUS_LABEL[ollamaConnection]
    });

    for (const p of localProviders) {
      if (p.providerType === "ollama") continue;
      const check = endpointChecks[p.id];
      const status: ConnectionStatus = !p.enabled
        ? "disconnected"
        : checkingIds.includes(p.id)
          ? "checking"
          : check
            ? check.ok
              ? "connected"
              : "disconnected"
            : "checking";
      entries.push({
        key: p.id,
        id: p.id,
        name: p.name || LOCAL_PROVIDER_LABELS[p.providerType],
        providerType: p.providerType,
        endpoint: p.endpoint,
        enabled: p.enabled,
        status,
        statusLabel: !p.enabled ? "Disabled" : STATUS_LABEL[status]
      });
    }

    return entries;
  }, [localProviders, ollamaStatus, endpointChecks, checkingIds]);

  // A stale failure message is meaningless once the provider reports connected.
  useEffect(() => {
    if (Object.keys(connectError).length === 0) return;
    setConnectError((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const entry of localEntries) {
        if (entry.status === "connected" && next[entry.key]) {
          delete next[entry.key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [localEntries, connectError]);

  /**
   * First run: nothing persisted yet — open the guided local AI setup
   * automatically. The manual provider chooser stays available through
   * "Advanced configuration".
   */
  const firstRun =
    localHydrated && localProviders.length === 0 && pendingTypes.length === 0;

  useEffect(() => {
    if (firstRun) setSetupOpen(true);
  }, [firstRun]);

  const cardEntries = useMemo<LocalProviderEntry[]>(() => {
    const list: LocalProviderEntry[] = [];
    for (const entry of localEntries) {
      if (firstRun && entry.id === null) continue;
      list.push(entry);
    }
    for (const type of pendingTypes) {
      if (list.some((e) => e.providerType === type)) continue;
      list.push({
        key: `pending:${type}`,
        id: null,
        name: LOCAL_PROVIDER_LABELS[type],
        providerType: type,
        endpoint: LOCAL_PROVIDER_DEFAULT_ENDPOINTS[type],
        enabled: true,
        status: "disconnected",
        statusLabel: "Disconnected"
      });
    }
    return list;
  }, [localEntries, firstRun, pendingTypes]);

  const missingTypes = useMemo(
    () =>
      LOCAL_PROVIDER_TYPES.filter(
        (t) => !cardEntries.some((e) => e.providerType === t)
      ),
    [cardEntries]
  );

  // The manual chooser is the advanced path — the guided setup panel owns
  // first-run and the "+ Add Local Provider" entry.
  const chooserVisible = chooserOpen && !setupOpen;

  const activeLocal = useMemo<LocalProviderEntry | null>(() => {
    if (activeLocalKey) {
      const chosen = localEntries.find((e) => e.key === activeLocalKey);
      if (chosen) return chosen;
    }
    if (provider === "local") {
      const owner = getProviderForModel(model);
      const byModel = owner ? localEntries.find((e) => e.id === owner.id) : undefined;
      if (byModel) return byModel;
    }
    return localEntries[0] ?? null;
  }, [activeLocalKey, localEntries, provider, model, getProviderForModel]);

  const isLocalProvider = provider === "local";

  const optionsFor = useCallback(
    (entry: LocalProviderEntry | null): ModelOption[] => {
      if (!entry) return [];
      if (entry.providerType === "ollama") {
        // Live discovery is the source of truth for Ollama; persisted rows are
        // never shown as installed models once the endpoint is unreachable.
        // A refresh (status "checking") keeps the last known list visible.
        if (entry.status === "disconnected") return [];
        return discoveredOllamaModels.map((m) => ({
          id: m.modelId,
          label: m.modelId,
          meta: formatMeta(m)
        }));
      }
      const persisted = localModels
        .filter((m) => m.providerId === entry.id && m.enabled)
        .map((m) => ({ id: m.modelId, label: m.displayName || m.modelId, meta: formatMeta(m) }));
      const options: ModelOption[] = [...persisted];
      const checked = entry.id ? endpointChecks[entry.id] : undefined;
      for (const id of checked?.models ?? []) {
        if (!options.some((o) => o.id === id)) options.push({ id, label: id, meta: undefined });
      }
      return options;
    },
    [discoveredOllamaModels, localModels, endpointChecks]
  );

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (!isLocalProvider) {
      const cloud = provider as Exclude<ProviderType, "local">;
      return (PROVIDER_MODEL_OPTIONS[cloud] ?? []).map((m) => ({
        id: m.id,
        label: m.badge ? `${m.label} (${m.badge})` : m.label
      }));
    }
    return optionsFor(activeLocal);
  }, [isLocalProvider, provider, activeLocal, optionsFor]);

  const cloudProvider = !isLocalProvider
    ? (provider as Exclude<ProviderType, "local">)
    : null;

  const modelValue =
    modelOptions.some((m) => m.id === model)
      ? model
      : cloudProvider
        ? DEFAULT_PROVIDER_MODELS[cloudProvider]
        : "";

  // Nothing selected yet for this local provider (fresh panel, or the previous
  // selection was removed) — default to its first model, mirroring how
  // setProvider("local") picks the first enabled local model.
  useEffect(() => {
    if (!isLocalProvider || !activeLocal || model) return;
    if (modelOptions.length === 0) return;
    void selectLocalModel(modelOptions[0].id);
  }, [isLocalProvider, activeLocal, model, modelOptions]);

  const providerValue =
    isLocalProvider && activeLocal ? `local:${activeLocal.key}` : provider;

  const handleProviderChange = (value: string) => {
    if (value.startsWith("local:")) {
      const key = value.slice("local:".length);
      const entry = localEntries.find((e) => e.key === key);
      setActiveLocalKey(key);
      if (provider !== "local") setProvider("local");
      // Keep the chat model consistent with the local provider the user picked.
      if (entry) {
        const opts = optionsFor(entry).map((o) => o.id);
        const current = useChatStore.getState().model;
        if (opts.length > 0 && !opts.includes(current)) void selectLocalModel(opts[0]);
      }
      return;
    }
    setProvider(value as ProviderType);
  };

  const endpointFor = (entry: LocalProviderEntry) =>
    endpointDrafts[entry.key] ?? entry.endpoint;

  const setEndpointDraft = (key: string, value: string) =>
    setEndpointDrafts((prev) => ({ ...prev, [key]: value }));

  const clearConnectError = (key: string) =>
    setConnectError((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const cardState = (entry: LocalProviderEntry): CardState => {
    if (connectingKey === entry.key) return "connecting";
    if (connectError[entry.key]) return "failed";
    if (entry.status === "connected") return "connected";
    if (entry.status === "checking") return "checking";
    return "disconnected";
  };

  /** Reuses the existing discovery / validation mechanism for one provider. */
  const refreshEntry = async (entry: LocalProviderEntry) => {
    if (entry.providerType === "ollama") {
      await refreshOllamaModels(endpointFor(entry));
      return;
    }
    if (!entry.id) return;
    const persisted = useLocalModelStore
      .getState()
      .providers.find((p) => p.id === entry.id);
    await runCheck(entry.id, endpointFor(entry), entry.providerType, persisted?.apiKey);
  };

  const handleConnect = async (entry: LocalProviderEntry) => {
    const endpoint = endpointFor(entry);
    if (validateEndpoint(endpoint)) {
      setConnectError((prev) => ({
        ...prev,
        [entry.key]: "That address doesn't look right. Check it under Advanced connection settings."
      }));
      setAdvancedOpen((prev) => ({ ...prev, [entry.key]: true }));
      return;
    }

    setConnectingKey(entry.key);
    clearConnectError(entry.key);

    try {
      if (entry.providerType === "ollama") {
        await refreshOllamaModels(endpoint);
        const st = useLocalModelStore.getState();
        if (st.ollamaStatus !== "connected") {
          if (entry.id) {
            setEndpointChecks((prev) => ({
              ...prev,
              [entry.id!]: { ok: false, message: "", models: [] }
            }));
          }
          setConnectError((prev) => ({
            ...prev,
            [entry.key]: connectionFailureMessage("ollama")
          }));
          return;
        }
        const normalized = normalizeEndpoint(endpoint, "ollama");
        let row = st.providers.find((p) => p.providerType === "ollama");
        if (!row) {
          row = await addLocalProvider({
            name: "Ollama",
            providerType: "ollama",
            endpoint: normalized
          });
        } else if (row.endpoint !== normalized || !row.enabled) {
          await updateLocalProvider(row.id, { endpoint: normalized, enabled: true });
        }
        setActiveLocalKey(row.id);
        const first = st.discoveredOllamaModels[0]?.modelId;
        if (first) await selectLocalModel(first);
        return;
      }

      // OpenAI-compatible providers (LM Studio, vLLM, custom endpoints) reuse
      // the same test/discovery helper the app already uses everywhere.
      const type = entry.providerType;
      const current = useLocalModelStore.getState();
      const existing = current.providers.find((p) => p.providerType === type);
      const res = await testLocalEndpoint(endpoint, type, existing?.apiKey);
      const models = res.models ?? [];
      if (entry.id) {
        setEndpointChecks((prev) => ({
          ...prev,
          [entry.id!]: { ok: res.ok, message: "", models }
        }));
      }
      if (!res.ok) {
        setConnectError((prev) => ({
          ...prev,
          [entry.key]: res.endpointReachable
            ? rejectionMessage(type)
            : connectionFailureMessage(type)
        }));
        return;
      }

      const normalized = normalizeEndpoint(endpoint, type);
      let row = existing;
      if (!row) {
        row = await addLocalProvider({
          name: LOCAL_PROVIDER_LABELS[type],
          providerType: type,
          endpoint: normalized
        });
      } else if (row.endpoint !== normalized || !row.enabled) {
        await updateLocalProvider(row.id, { endpoint: normalized, enabled: true });
      }
      setActiveLocalKey(row.id);
      for (const m of models) {        try {
          await addLocalModel(row.id, m);
        } catch {
          // Best-effort persistence — discovery already succeeded.
        }
      }
      setEndpointChecks((prev) => ({ ...prev, [row!.id]: { ok: true, message: "", models } }));
      if (models.length > 0) await selectLocalModel(models[0]);
    } catch {
      setConnectError((prev) => ({
        ...prev,
        [entry.key]: connectionFailureMessage(entry.providerType)
      }));
    } finally {
      setConnectingKey(null);
    }
  };

  const handleDisconnect = async (entry: LocalProviderEntry) => {
    try {
      const st = useLocalModelStore.getState();
      const row =
        (entry.id ? st.providers.find((p) => p.id === entry.id) : undefined) ??
        st.providers.find((p) => p.providerType === entry.providerType);
      const target =
        row ??
        (await addLocalProvider({
          name: entry.name,
          providerType: entry.providerType,
          endpoint: normalizeEndpoint(endpointFor(entry), entry.providerType)
        }));
      await updateLocalProvider(target.id, { enabled: false });
      if (entry.providerType === "ollama") clearDiscoveredOllamaModels();
      clearConnectError(entry.key);
      setActiveLocalKey((prev) => (prev === entry.key ? null : prev));

      // The chat must not stay on a provider that is no longer reachable.
      const chat = useChatStore.getState();
      if (chat.provider === "local") {
        const after = useLocalModelStore.getState();
        const alive = after.models.filter(
          (m) => m.enabled && after.providers.some((p) => p.id === m.providerId && p.enabled)
        );
        if (alive.length > 0) await selectLocalModel(alive[0].modelId);
        else chat.setProvider("groq");
      }
    } catch {
      // Best-effort: the card always reflects the store state.
    }
  };

  const pickProviderType = (type: LocalProviderType) => {
    setPendingTypes((prev) => (prev.includes(type) ? prev : [...prev, type]));
    setChooserOpen(false);
    if (type === "generic") {
      setAdvancedOpen((prev) => ({ ...prev, [`pending:${type}`]: true }));
    }
  };

  const renderAdvancedSettings = (entry: LocalProviderEntry) => {
    const open = !!advancedOpen[entry.key];
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() =>
            setAdvancedOpen((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))
          }
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <ChevronDownIcon
            className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
          Advanced connection settings
        </button>
        {open && (
          <div className="space-y-1">
            <label
              htmlFor={`local-endpoint-${entry.key}`}
              className="block text-[11px] font-medium text-muted-foreground"
            >
              Endpoint
            </label>
            <input
              id={`local-endpoint-${entry.key}`}
              value={endpointFor(entry)}
              onChange={(e) => setEndpointDraft(entry.key, e.target.value)}
              placeholder={LOCAL_PROVIDER_DEFAULT_ENDPOINTS[entry.providerType]}
              className={INPUT_CLASSES}
            />
          </div>
        )}
      </div>
    );
  };

  const renderCard = (entry: LocalProviderEntry) => {
    const state = cardState(entry);
    const options = optionsFor(entry);
    // Exactly one "Model" picker exists at a time: the active local provider's
    // card owns it while a local provider is selected, the Models section owns
    // it for cloud providers.
    const showPicker =
      isLocalProvider && activeLocal?.key === entry.key && options.length > 0;
    const value = options.some((o) => o.id === model) ? model : "";
    const selectedMeta = options.find((o) => o.id === value)?.meta;
    // A persisted, enabled provider that is still being probed (first check
    // after a reload, or a refresh) stays in the connected layout — only an
    // unreachable endpoint drops the card back to "Not connected".
    const isUp =
      state === "connected" || (state === "checking" && !!entry.id && entry.enabled);
    const busy = state === "connecting" || state === "checking";
    const showConnect =
      state === "disconnected" || state === "failed" || (state === "checking" && !isUp);
    const showAdvanced = state === "disconnected" || state === "failed";

    return (
      <li
        key={entry.key}
        data-testid={`local-provider-card-${entry.providerType}`}
        className="space-y-3 rounded-xl border border-border bg-muted/20 p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-xs font-bold text-foreground">{entry.name}</p>
            {(state === "connecting" || (state === "checking" && !isUp)) && (
              <p className="text-[11px] text-muted-foreground">
                Connecting to {entry.name}…
              </p>
            )}
            {isUp && (
              <p className="text-[11px] text-muted-foreground">
                {state === "checking"
                  ? "Checking models…"
                  : `${options.length} ${options.length === 1 ? "model" : "models"} available`}
              </p>
            )}
            {state === "disconnected" && (
              <p className="text-[11px] text-muted-foreground">
                {PROVIDER_BLURB[entry.providerType]}
              </p>
            )}
          </div>
          <StatusPill state={state} />
        </div>

        {state === "failed" && (
          <p role="alert" className="text-[11px] leading-relaxed text-destructive">
            {connectError[entry.key]}
          </p>
        )}

        {state === "connected" && options.length === 0 && (
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-foreground">No models found</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Your provider is connected, but no models are available yet.
            </p>
          </div>
        )}

        {showPicker && (
          <div className="space-y-1.5">
            <label
              htmlFor={`local-model-${entry.key}`}
              className="block text-[11px] font-medium text-muted-foreground"
            >
              Model
            </label>
            <select
              id={`local-model-${entry.key}`}
              value={value}
              onChange={(e) => void selectLocalModel(e.target.value)}
              className={SELECT_CLASSES}
            >
              {value === "" && <option value="">Select a model…</option>}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {value && (
              <p
                className="truncate text-[11px] font-mono text-muted-foreground"
                data-testid="selected-model-meta"
              >
                {value}
                {selectedMeta ? ` — ${selectedMeta}` : ""}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {state === "connecting" && (
            <button type="button" disabled className={PRIMARY_BUTTON_CLASSES}>
              Connecting…
            </button>
          )}

          {showConnect && (
            <button
              type="button"
              onClick={() => void handleConnect(entry)}
              disabled={busy}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {state === "failed" ? "Retry" : CONNECT_LABEL[entry.providerType]}
            </button>
          )}

          {isUp && (
            <>
              <button
                type="button"
                onClick={() => void refreshEntry(entry)}
                disabled={busy}
                className={SECONDARY_BUTTON_CLASSES}
              >
                Refresh Models
              </button>
              <button
                type="button"
                onClick={() => void handleDisconnect(entry)}
                className={SECONDARY_BUTTON_CLASSES}
              >
                Disconnect
              </button>
            </>
          )}

          {entry.id && (state === "disconnected" || state === "failed") && (
            <button
              type="button"
              onClick={() => void removeLocalProvider(entry.id as string)}
              className="ml-auto text-[11px] text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
            >
              Remove
            </button>
          )}
        </div>

        {showAdvanced && renderAdvancedSettings(entry)}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-border bg-card p-3.5 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          Models
        </h4>

        <div className="space-y-1.5">
          <label htmlFor="settings-models-provider" className="block text-xs font-medium text-foreground">
            Provider
          </label>
          <select
            id="settings-models-provider"
            value={providerValue}
            onChange={(e) => handleProviderChange(e.target.value)}
            className={SELECT_CLASSES}
          >
            <optgroup label="Cloud">
              {CLOUD_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Local">
              {localEntries.map((entry) => (
                <option key={entry.key} value={`local:${entry.key}`}>
                  {entry.name} • {entry.statusLabel}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        {/* Cloud models are picked here; local models are picked on the
            provider card below, right after connecting. */}
        {!isLocalProvider && (
          <div className="space-y-1.5">
            <label
              htmlFor="settings-models-model"
              className="block text-xs font-medium text-foreground"
            >
              Model
            </label>
            <select
              id="settings-models-model"
              value={modelValue}
              onChange={(e) => setModel(e.target.value)}
              className={SELECT_CLASSES}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] font-mono text-muted-foreground">
              {modelOptions.length} {modelOptions.length === 1 ? "model" : "models"}
            </p>
          </div>
        )}

        {isLocalProvider && (
          <p className="text-[11px] text-muted-foreground">
            Local models are picked on the provider card below.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-3.5 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
            Local Providers
          </h4>
          {!setupOpen && !chooserVisible && missingTypes.length > 0 && (
            <button
              type="button"
              onClick={() => setSetupOpen(true)}
              className="rounded-xl bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:opacity-90 cursor-pointer"
            >
              + Add Local Provider
            </button>
          )}
        </div>

        {!localHydrated ? (
          <p className="text-[11px] font-mono text-muted-foreground">Loading local providers…</p>
        ) : (
          <div className="space-y-2">
            {setupOpen && localHydrated && (
              <LocalSetupPanel
                onClose={() => setSetupOpen(false)}
                onAdvanced={() => {
                  setSetupOpen(false);
                  setChooserOpen(true);
                }}
              />
            )}

            {chooserVisible && (
              <ProviderChooser
                types={missingTypes.length > 0 ? missingTypes : LOCAL_PROVIDER_TYPES}
                onPick={pickProviderType}
                onCancel={() => setChooserOpen(false)}
              />
            )}

            {cardEntries.map((entry) => renderCard(entry))}

            {!chooserVisible && !setupOpen && cardEntries.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No local providers yet.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
