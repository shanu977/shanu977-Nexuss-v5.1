"use client";

import { useEffect, useMemo, useState } from "react";
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
  isDesktop
} from "@/types/localModels";
import { getErrorMessage } from "@/utils";

const CLOUD_PROVIDERS: ProviderType[] = ["groq", "gemini", "openrouter"];

type ConnectionStatus = "connected" | "checking" | "disconnected" | "configured";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  checking: "Checking…",
  disconnected: "Disconnected",
  configured: "Configured"
};

// Connection state is always spelled out in text as well: color alone never
// carries the meaning.
const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  checking: "text-muted-foreground",
  disconnected: "text-amber-600 dark:text-amber-400",
  configured: "text-muted-foreground"
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connected: "bg-emerald-500",
  checking: "bg-muted-foreground animate-pulse",
  disconnected: "bg-amber-500",
  configured: "bg-muted-foreground"
};

interface LocalProviderEntry {
  /** Value used in the Provider <select> after the "local:" prefix. */
  key: string;
  /** Persisted LocalProvider id, or null when only known through discovery. */
  id: string | null;
  name: string;
  providerType: LocalProviderType;
  endpoint: string;
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

function formatMeta(
  m: { family?: string; parameterSize?: string; size?: number }
): string | undefined {
  const disk = m.size ? `${(m.size / 1e9).toFixed(1)} GB disk` : null;
  const parts = [m.family, m.parameterSize, disk].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

const SELECT_CLASSES =
  "w-full cursor-pointer rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring";

const SECONDARY_BUTTON_CLASSES =
  "rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const PRIMARY_BUTTON_CLASSES =
  "rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const SMALL_BUTTON_CLASSES =
  "rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-mono text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

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
  const removeLocalModel = useLocalModelStore((s) => s.removeModel);
  const toggleLocalModel = useLocalModelStore((s) => s.toggleModel);
  const getProviderForModel = useLocalModelStore((s) => s.getProviderForModel);
  const discoveredOllamaModels = useLocalModelStore((s) => s.discoveredOllamaModels);
  const ollamaStatus = useLocalModelStore((s) => s.ollamaStatus);
  const ollamaError = useLocalModelStore((s) => s.ollamaError);
  const ollamaLastRefresh = useLocalModelStore((s) => s.ollamaLastRefresh);
  const ollamaPullProgress = useLocalModelStore((s) => s.ollamaPullProgress);
  const refreshOllamaModels = useLocalModelStore((s) => s.refreshOllamaModels);
  const recommendOllamaModel = useLocalModelStore((s) => s.recommendOllamaModel);
  const pullOllamaModel = useLocalModelStore((s) => s.pullOllamaModel);

  // ---- Local provider connection flow (preserved from the old UI) ----
  const [showAddLocal, setShowAddLocal] = useState(false);
  const [localProviderType, setLocalProviderType] = useState<LocalProviderType>("ollama");
  const [localEndpoint, setLocalEndpoint] = useState(LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localTestResult, setLocalTestResult] = useState<{ ok: boolean; message: string; models?: string[] } | null>(null);
  const [localTesting, setLocalTesting] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [localSaving, setLocalSaving] = useState(false);
  const [localMessage, setLocalMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [recommendedOllamaModel, setRecommendedOllamaModel] = useState<string | null>(null);
  const [ollamaDownloading, setOllamaDownloading] = useState(false);

  // ---- Local provider management ----
  const [managingId, setManagingId] = useState<string | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editEndpoint, setEditEndpoint] = useState("");
  const [editName, setEditName] = useState("");
  const [endpointChecks, setEndpointChecks] = useState<Record<string, EndpointCheck>>({});
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const [activeLocalKey, setActiveLocalKey] = useState<string | null>(null);

  useEffect(() => {
    if (!localHydrated) void hydrateLocal();
  }, [localHydrated, hydrateLocal]);

  useEffect(() => {
    void refreshOllamaModels();
  }, [refreshOllamaModels]);

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

  // Desktop-only: suggest a model to download when nothing is installed yet.
  useEffect(() => {
    if (ollamaStatus !== "connected") return;
    if (discoveredOllamaModels.length > 0) return;
    void recommendOllamaModel().then((modelId) => {
      setRecommendedOllamaModel(modelId);
    });
  }, [ollamaStatus, discoveredOllamaModels.length, recommendOllamaModel]);

  useEffect(() => {
    setLocalEndpoint(LOCAL_PROVIDER_DEFAULT_ENDPOINTS[localProviderType]);
    setLocalTestResult(null);
    setDiscoveredModels([]);
  }, [localProviderType]);

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
      // "idle" / "loading" — discovery runs as soon as the tab opens.
      ollamaConnection = "checking";
    }
    entries.push({
      key: persistedOllama ? persistedOllama.id : "ollama",
      id: persistedOllama?.id ?? null,
      name: persistedOllama?.name || "Ollama",
      providerType: "ollama",
      endpoint: persistedOllama?.endpoint || LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama,
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
            : "configured";
      entries.push({
        key: p.id,
        id: p.id,
        name: p.name || LOCAL_PROVIDER_LABELS[p.providerType],
        providerType: p.providerType,
        endpoint: p.endpoint,
        status,
        statusLabel: !p.enabled ? "Disabled" : STATUS_LABEL[status]
      });
    }

    return entries;
  }, [localProviders, ollamaStatus, endpointChecks, checkingIds]);

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
  const isOllama = isLocalProvider && activeLocal?.providerType === "ollama";

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (!isLocalProvider || !activeLocal) {
      const cloud = provider as Exclude<ProviderType, "local">;
      return (PROVIDER_MODEL_OPTIONS[cloud] ?? []).map((m) => ({
        id: m.id,
        label: m.badge ? `${m.label} (${m.badge})` : m.label
      }));
    }

    if (activeLocal.providerType === "ollama") {
      // Live discovery is the source of truth for Ollama; persisted rows are
      // never shown as installed models while the endpoint is unreachable.
      if (ollamaStatus === "not_connected" || ollamaStatus === "error") return [];
      return discoveredOllamaModels.map((m) => ({
        id: m.modelId,
        label: m.modelId,
        meta: formatMeta(m)
      }));
    }

    const persisted = localModels
      .filter((m) => m.providerId === activeLocal.id && m.enabled)
      .map((m) => ({ id: m.modelId, label: m.displayName || m.modelId, meta: formatMeta(m) }));
    const options: ModelOption[] = [...persisted];
    const checked = activeLocal.id ? endpointChecks[activeLocal.id] : undefined;
    for (const id of checked?.models ?? []) {
      if (!options.some((o) => o.id === id)) options.push({ id, label: id, meta: undefined });
    }
    return options;
  }, [
    isLocalProvider,
    activeLocal,
    provider,
    ollamaStatus,
    discoveredOllamaModels,
    localModels,
    endpointChecks
  ]);

  const cloudProvider = !isLocalProvider
    ? (provider as Exclude<ProviderType, "local">)
    : null;

  const modelValue = modelOptions.some((m) => m.id === model)
    ? model
    : cloudProvider
      ? DEFAULT_PROVIDER_MODELS[cloudProvider]
      : "";

  const selectedMeta = isLocalProvider
    ? modelOptions.find((m) => m.id === model)?.meta
    : undefined;

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
        const opts =
          entry.providerType === "ollama"
            ? ollamaStatus === "connected"
              ? discoveredOllamaModels.map((m) => m.modelId)
              : []
            : localModels
                .filter((m) => m.providerId === entry.id && m.enabled)
                .map((m) => m.modelId);
        const current = useChatStore.getState().model;
        if (opts.length > 0 && !opts.includes(current)) void selectLocalModel(opts[0]);
      }
      return;
    }
    setProvider(value as ProviderType);
  };

  const refreshLocalProvider = async (entry: LocalProviderEntry) => {
    if (entry.providerType === "ollama") {
      await refreshOllamaModels(entry.endpoint);
      return;
    }
    if (!entry.id) return;
    const persisted = localProviders.find((p) => p.id === entry.id);
    setCheckingIds((prev) => [...prev, entry.id!]);
    try {
      const res = await testLocalEndpoint(entry.endpoint, entry.providerType, persisted?.apiKey);
      setEndpointChecks((prev) => ({
        ...prev,
        [entry.id!]: { ok: res.ok, message: res.message, models: res.models ?? [] }
      }));
      setLocalMessage({ type: res.ok ? "success" : "error", text: `${entry.name}: ${res.message}` });
    } catch (e) {
      setEndpointChecks((prev) => ({
        ...prev,
        [entry.id!]: { ok: false, message: getErrorMessage(e), models: [] }
      }));
      setLocalMessage({ type: "error", text: `${entry.name}: ${getErrorMessage(e)}` });
    } finally {
      setCheckingIds((prev) => prev.filter((id) => id !== entry.id));
    }
  };

  const handleRefresh = () => {
    if (activeLocal) void refreshLocalProvider(activeLocal);
  };

  const openManage = (entry: LocalProviderEntry) => {
    if (entry.id) {
      setManagingId((prev) => (prev === entry.id ? null : (entry.id as string)));
      setEditingProviderId(null);
    } else {
      // Nothing persisted yet — the connection flow is the way to configure it.
      setShowAddLocal(true);
    }
  };

  const handleTestLocal = async () => {
    const err = validateEndpoint(localEndpoint);
    if (err) {
      setLocalTestResult({ ok: false, message: err });
      return;
    }
    setLocalTesting(true);
    setLocalTestResult(null);
    setDiscoveredModels([]);
    try {
      const res = await testLocalEndpoint(localEndpoint, localProviderType, localApiKey);
      setLocalTestResult({ ok: res.ok, message: res.message, models: res.models });
      if (res.models && res.models.length > 0) {
        setDiscoveredModels(res.models);
        setSelectedModelId(res.models[0]);
      }
    } catch (e) {
      setLocalTestResult({ ok: false, message: getErrorMessage(e) });
    } finally {
      setLocalTesting(false);
    }
  };

  const handleAddLocal = async () => {
    const err = validateEndpoint(localEndpoint);
    if (err) {
      setLocalMessage({ type: "error", text: err });
      return;
    }
    const modelId = selectedModelId.trim() || manualModelId.trim();
    if (!modelId) {
      setLocalMessage({ type: "error", text: "Select or enter a model ID." });
      return;
    }
    setLocalSaving(true);
    setLocalMessage(null);
    try {
      const normalized = normalizeEndpoint(localEndpoint, localProviderType);
      let localProvider = localProviders.find(
        (p) => p.endpoint === normalized && p.providerType === localProviderType
      );
      if (!localProvider) {
        localProvider = await addLocalProvider({
          name: LOCAL_PROVIDER_LABELS[localProviderType],
          providerType: localProviderType,
          endpoint: localEndpoint,
          apiKey: localApiKey.trim() || undefined
        });
      }
      await addLocalModel(localProvider.id, modelId);
      setLocalMessage({
        type: "success",
        text: `Added ${modelId} (${LOCAL_PROVIDER_LABELS[localProviderType]})`
      });
      setManualModelId("");
      setSelectedModelId("");
      setShowAddLocal(false);
      setLocalTestResult(null);
      setDiscoveredModels([]);
    } catch (e) {
      setLocalMessage({ type: "error", text: getErrorMessage(e) });
    } finally {
      setLocalSaving(false);
    }
  };

  const renderModelField = () => {
    if (!isLocalProvider || !activeLocal) {
      return (
        <select
          id="settings-models-model"
          aria-labelledby="settings-models-model-label"
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
      );
    }

    if (activeLocal.status === "checking" && modelOptions.length === 0) {
      return (
        <div className="rounded-xl border border-input bg-background px-3 py-2.5 text-xs text-muted-foreground" role="status">
          {ollamaPullProgress ? (
            <span>
              {ollamaPullProgress.status}
              {ollamaPullProgress.percent != null ? ` — ${Math.round(ollamaPullProgress.percent)}%` : ""}
            </span>
          ) : (
            <span>Discovering installed models…</span>
          )}
        </div>
      );
    }

    if (activeLocal.status === "disconnected") {
      return (
        <div className="space-y-2 rounded-xl border border-dashed border-border bg-muted/30 px-3 py-3" role="status">
          <p className="text-xs font-medium text-foreground">
            {activeLocal.name} • Disconnected
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {ollamaError && activeLocal.providerType === "ollama"
              ? ollamaError
              : "The endpoint is not reachable. Start the local server, then reconnect."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleRefresh} className={SECONDARY_BUTTON_CLASSES}>
              Reconnect
            </button>
            <button type="button" onClick={() => openManage(activeLocal)} className={SECONDARY_BUTTON_CLASSES}>
              Configure
            </button>
          </div>
        </div>
      );
    }

    if (modelOptions.length === 0) {
      return (
        <div className="space-y-2 rounded-xl border border-dashed border-border bg-muted/30 px-3 py-3">
          <p className="text-xs font-medium text-foreground">No local models found</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Install a model in {activeLocal.name}, then refresh.
          </p>
          {isDesktop() && recommendedOllamaModel && activeLocal.providerType === "ollama" ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-medium">{recommendedOllamaModel}</p>
                <p className="text-[10px] text-muted-foreground">Recommended for this computer</p>
              </div>
              <button
                type="button"
                disabled={ollamaDownloading}
                onClick={async () => {
                  setOllamaDownloading(true);
                  try {
                    await pullOllamaModel(recommendedOllamaModel);
                  } catch (e) {
                    console.error("Ollama model download failed:", e);
                  } finally {
                    setOllamaDownloading(false);
                  }
                }}
                className={`${PRIMARY_BUTTON_CLASSES} shrink-0`}
              >
                {ollamaDownloading ? "Downloading…" : "Download"}
              </button>
            </div>
          ) : null}
          {activeLocal.providerType !== "ollama" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => openManage(activeLocal)} className={SECONDARY_BUTTON_CLASSES}>
                Manage
              </button>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-1.5">
        <select
          id="settings-models-model"
          aria-labelledby="settings-models-model-label"
          value={modelValue}
          onChange={(e) => void selectLocalModel(e.target.value)}
          className={SELECT_CLASSES}
        >
          {modelValue === "" && <option value="">Select a model…</option>}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {(selectedMeta || modelValue) && (
          <p className="truncate text-[11px] font-mono text-muted-foreground" data-testid="selected-model-meta">
            {modelValue}
            {selectedMeta ? ` — ${selectedMeta}` : ""}
          </p>
        )}
        {model && modelValue === "" && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Selected model “{model}” is not available for {activeLocal.name}. Pick another.
          </p>
        )}
      </div>
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

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label id="settings-models-model-label" className="block text-xs font-medium text-foreground">
              Model
            </label>
            {isLocalProvider && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-primary">
                Local
              </span>
            )}
          </div>
          {renderModelField()}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={handleRefresh} disabled={activeLocal?.status === "checking"} className={SECONDARY_BUTTON_CLASSES}>
            Refresh Models
          </button>
          <span className="text-[10px] font-mono text-muted-foreground">
            {isLocalProvider
              ? `${modelOptions.length} ${modelOptions.length === 1 ? "model" : "models"}${
                  isOllama && ollamaLastRefresh
                    ? ` · Refreshed ${new Date(ollamaLastRefresh).toLocaleTimeString()}`
                    : ""
                }`
              : `${modelOptions.length} models`}
          </span>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-3.5 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
            Local Providers
          </h4>
          <button
            type="button"
            onClick={() => setShowAddLocal((v) => !v)}
            className="rounded-xl bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:opacity-90 cursor-pointer"
          >
            {showAddLocal ? "Cancel" : "+ Add Local Provider"}
          </button>
        </div>

        {!localHydrated ? (
          <p className="text-[11px] font-mono text-muted-foreground">Loading local providers…</p>
        ) : (
          <ul className="space-y-2">
            {localEntries.map((entry) => {
              const modelsForProvider = localModels.filter((m) => m.providerId === entry.id);
              const isManaging = !!entry.id && managingId === entry.id;
              const isEditing = editingProviderId === entry.id;
              return (
                <li key={entry.key} className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold font-mono text-foreground">{entry.name}</p>
                      <p className="truncate text-[11px] font-mono text-muted-foreground">{entry.endpoint}</p>
                    </div>
                    <span
                      className={`flex shrink-0 items-center gap-1.5 text-[10px] font-mono font-medium ${STATUS_TEXT[entry.status]}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[entry.status]}`} aria-hidden="true" />
                      {entry.statusLabel}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <button type="button" onClick={() => openManage(entry)} className={SMALL_BUTTON_CLASSES}>
                      Manage
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshLocalProvider(entry)}
                      disabled={entry.status === "checking"}
                      className={SMALL_BUTTON_CLASSES}
                    >
                      Refresh
                    </button>
                  </div>

                  {isManaging && entry.id && (
                    <div className="space-y-2 rounded-lg border border-border bg-card p-2.5">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="Name"
                            aria-label="Provider name"
                            className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                          />
                          <input
                            value={editEndpoint}
                            onChange={(e) => setEditEndpoint(e.target.value)}
                            placeholder="Endpoint"
                            aria-label="Provider endpoint"
                            className="w-full rounded-lg border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                const err = validateEndpoint(editEndpoint);
                                if (err) {
                                  setLocalMessage({ type: "error", text: err });
                                  return;
                                }
                                await updateLocalProvider(entry.id as string, {
                                  name: editName.trim() || entry.name,
                                  endpoint: editEndpoint
                                });
                                setEditingProviderId(null);
                              }}
                              className={`${PRIMARY_BUTTON_CLASSES} px-3 py-1`}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingProviderId(null)}
                              className={SMALL_BUTTON_CLASSES}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void refreshLocalProvider(entry)}
                            className={SMALL_BUTTON_CLASSES}
                          >
                            Test
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingProviderId(entry.id as string);
                              setEditEndpoint(entry.endpoint);
                              setEditName(entry.name);
                            }}
                            className={SMALL_BUTTON_CLASSES}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeLocalProvider(entry.id as string)}
                            className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-mono text-destructive hover:bg-destructive/20 cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      )}

                      {endpointChecks[entry.id]?.message && (
                        <p
                          role="status"
                          className={`text-[11px] font-mono ${endpointChecks[entry.id].ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                        >
                          {endpointChecks[entry.id].message}
                        </p>
                      )}

                      <div className="space-y-1.5">
                        <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                          Models ({modelsForProvider.length})
                        </p>
                        {modelsForProvider.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">
                            No models added for this endpoint.
                          </p>
                        ) : (
                          modelsForProvider.map((m) => (
                            <div
                              key={m.id}
                              className="flex items-center justify-between rounded-lg border border-border bg-background px-2.5 py-2"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-xs font-mono font-medium">{m.displayName}</p>
                                <p className="truncate text-[10px] font-mono text-muted-foreground">
                                  {[m.family, m.parameterSize, m.size ? `${(m.size / 1e9).toFixed(1)} GB disk` : ""]
                                    .filter(Boolean)
                                    .join(" • ") || m.modelId}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void toggleLocalModel(m.id, !m.enabled)}
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${
                                    m.enabled
                                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                      : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {m.enabled ? "Enabled" : "Disabled"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeLocalModel(m.id)}
                                  className="rounded-lg border border-border bg-muted px-2 py-1 text-[10px] font-mono hover:bg-card cursor-pointer"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {showAddLocal && (
          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
              Connect a local provider
            </p>
            <div className="space-y-1.5">
              <label htmlFor="local-provider-type" className="block text-xs font-medium text-foreground">
                Provider
              </label>
              <select
                id="local-provider-type"
                value={localProviderType}
                onChange={(e) => setLocalProviderType(e.target.value as LocalProviderType)}
                className={SELECT_CLASSES}
              >
                {(Object.keys(LOCAL_PROVIDER_LABELS) as LocalProviderType[]).map((t) => (
                  <option key={t} value={t}>
                    {LOCAL_PROVIDER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="local-provider-endpoint" className="block text-xs font-medium text-foreground">
                Endpoint
              </label>
              <input
                id="local-provider-endpoint"
                value={localEndpoint}
                onChange={(e) => setLocalEndpoint(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="text-[10px] font-mono text-muted-foreground">
                Examples: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), http://localhost:8000/v1 (vLLM)
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="local-provider-api-key" className="block text-xs font-medium text-foreground">
                API Key <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                id="local-provider-api-key"
                type="password"
                value={localApiKey}
                onChange={(e) => setLocalApiKey(e.target.value)}
                placeholder="Optional"
                autoComplete="off"
                className="w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button type="button" onClick={() => void handleTestLocal()} disabled={localTesting} className={SECONDARY_BUTTON_CLASSES}>
              {localTesting ? "Testing..." : "Test Connection"}
            </button>
            {localTestResult && (
              <p role="status" className={`text-[11px] font-mono ${localTestResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                {localTestResult.message}
              </p>
            )}
            {discoveredModels.length > 0 && (
              <div className="space-y-1.5">
                <label htmlFor="local-discovered-model" className="block text-xs font-medium text-foreground">
                  Available Models
                </label>
                <select
                  id="local-discovered-model"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                  className={SELECT_CLASSES}
                >
                  {discoveredModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="local-model-id" className="block text-xs font-medium text-foreground">
                Model ID {discoveredModels.length > 0 ? <span className="font-normal text-muted-foreground">(or manual)</span> : null}
              </label>
              <input
                id="local-model-id"
                value={manualModelId}
                onChange={(e) => setManualModelId(e.target.value)}
                placeholder={discoveredModels.length > 0 ? "Or enter manually, e.g. llama3.2:3b" : "e.g. llama3.2:3b, qwen2.5:7b, mistral"}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              {discoveredModels.length === 0 && localTestResult?.ok && (
                <p className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                  Model discovery unavailable — enter the model ID manually.
                </p>
              )}
            </div>
            <button type="button" onClick={() => void handleAddLocal()} disabled={localSaving} className={PRIMARY_BUTTON_CLASSES}>
              {localSaving ? "Adding..." : "Add Model"}
            </button>
            <div className="rounded-lg bg-muted p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <p className="font-semibold text-foreground">Quick setup (Ollama):</p>
              <ol className="mt-1 list-decimal list-inside space-y-0.5 font-mono text-[10px]">
                <li>Install Ollama from ollama.com</li>
                <li>
                  Run: <code className="rounded border border-border bg-background px-1 py-0.5">ollama pull llama3.2:3b</code>
                </li>
                <li>
                  Ensure Ollama allows CORS: <code className="rounded border border-border bg-background px-1 py-0.5">OLLAMA_ORIGINS=* ollama serve</code>
                </li>
                <li>
                  Add endpoint <code className="rounded border border-border bg-background px-1 py-0.5">http://localhost:11434/v1</code> and test
                </li>
              </ol>
            </div>
          </div>
        )}

        {localMessage && (
          <p
            role="status"
            className={`text-[11px] font-mono ${localMessage.type === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
          >
            {localMessage.text}
          </p>
        )}
      </section>
    </div>
  );
}
