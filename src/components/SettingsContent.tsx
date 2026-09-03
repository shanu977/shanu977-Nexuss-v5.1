"use client";

import { useEffect, useState } from "react";
import { ProviderType } from "@/types";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_MODEL_OPTIONS
} from "@/types/providers";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { useChatStore } from "@/store";
import { useLocalModelStore } from "@/store/localModelStore";
import { apiKeyService, ApiKeyStatus } from "@/services/apiKeys";
import { testLocalEndpoint } from "@/services/localModels";
import { LOCAL_PROVIDER_LABELS, LocalProviderType, LOCAL_PROVIDER_DEFAULT_ENDPOINTS, validateEndpoint, normalizeEndpoint } from "@/types/localModels";
import { getErrorMessage } from "@/utils";
import UsageDashboard from "@/components/UsageDashboard";

type ApiKeyProvider = "groq" | "gemini" | "openrouter";

const KEY_FIELDS: ApiKeyProvider[] = ["groq", "gemini", "openrouter"];

const EMPTY_STATUS: Record<ApiKeyProvider, ApiKeyStatus> = {
  groq: { provider: "groq", has_key: false, updatedAt: 0 },
  gemini: { provider: "gemini", has_key: false, updatedAt: 0 },
  openrouter: { provider: "openrouter", has_key: false, updatedAt: 0 }
};

export default function SettingsContent() {
  const theme = useChatStore((s) => s.theme);
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const setTheme = useChatStore((s) => s.setTheme);
  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);
  const providers: ProviderType[] = ["groq", "gemini", "openrouter", "local"];

  const [activeTab, setActiveTab] = useState<"general" | "keys" | "models" | "usage">("general");

  // ---- API key management ----
  const [keyStatus, setKeyStatus] = useState<Record<ApiKeyProvider, ApiKeyStatus>>(
    EMPTY_STATUS
  );
  const [inputs, setInputs] = useState<Record<ApiKeyProvider, string>>({
    groq: "",
    gemini: "",
    openrouter: ""
  });
  const [visible, setVisible] = useState<Record<ApiKeyProvider, boolean>>({
    groq: false,
    gemini: false,
    openrouter: false
  });
  const [saving, setSaving] = useState<ApiKeyProvider | null>(null);
  const [testing, setTesting] = useState<ApiKeyProvider | null>(null);
  const [apiMessage, setApiMessage] = useState<{
    type: "success" | "error";
    text: string;
    provider?: ApiKeyProvider;
  } | null>(null);

  // ---- Local models ----
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
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editEndpoint, setEditEndpoint] = useState("");
  const [editName, setEditName] = useState("");

  useEffect(() => {
    if (activeTab === "models" && !localHydrated) void hydrateLocal();
  }, [activeTab, localHydrated, hydrateLocal]);

  useEffect(() => {
    setLocalEndpoint(LOCAL_PROVIDER_DEFAULT_ENDPOINTS[localProviderType]);
    setLocalTestResult(null);
    setDiscoveredModels([]);
  }, [localProviderType]);

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
      // Find existing provider with same endpoint+type or create new
      let provider = localProviders.find((p) => p.endpoint === normalized && p.providerType === localProviderType);
      if (!provider) {
        provider = await addLocalProvider({
          name: LOCAL_PROVIDER_LABELS[localProviderType],
          providerType: localProviderType,
          endpoint: localEndpoint,
          apiKey: localApiKey.trim() || undefined,
        });
      }
      await addLocalModel(provider.id, modelId);
      setLocalMessage({ type: "success", text: `Added ${modelId} (${LOCAL_PROVIDER_LABELS[localProviderType]})` });
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

  useEffect(() => {
    apiKeyService
      .list()
      .then((statuses) => {
        const next = { ...EMPTY_STATUS };
        for (const s of statuses) {
          if (s.provider in next) next[s.provider as ApiKeyProvider] = s;
        }
        setKeyStatus(next);
      })
      .catch(() => {
        setApiMessage({
          type: "error",
          text: "Could not load API key status. Check your connection."
        });
      });
  }, []);

  const handleTestKey = async (field: ApiKeyProvider) => {
    const value = inputs[field].trim();
    if (!value) {
      setApiMessage({
        type: "error",
        text: "Enter an API key to test.",
        provider: field
      });
      return;
    }
    setTesting(field);
    setApiMessage(null);
    try {
      const result = await apiKeyService.test(field, value);
      setApiMessage({
        type: result.valid ? "success" : "error",
        text: result.message,
        provider: field
      });
    } catch (e: unknown) {
      setApiMessage({
        type: "error",
        text: getErrorMessage(e),
        provider: field
      });
    } finally {
      setTesting(null);
    }
  };

  const handleSaveKey = async (field: ApiKeyProvider) => {
    const value = inputs[field].trim();
    if (!value) {
      setApiMessage({
        type: "error",
        text: "Enter an API key to save.",
        provider: field
      });
      return;
    }
    setSaving(field);
    setApiMessage(null);
    try {
      const status = await apiKeyService.save(field, value);
      setKeyStatus((prev) => ({ ...prev, [field]: status }));
      setInputs((prev) => ({ ...prev, [field]: "" }));
      setApiMessage({
        type: "success",
        text: `${PROVIDER_LABELS[field]} API key connected successfully.`,
        provider: field
      });
    } catch (e: unknown) {
      setApiMessage({
        type: "error",
        text: getErrorMessage(e),
        provider: field
      });
    } finally {
      setSaving(null);
    }
  };

  const handleRemoveKey = async (field: ApiKeyProvider) => {
    setSaving(field);
    setApiMessage(null);
    try {
      await apiKeyService.remove(field);
      setKeyStatus((prev) => ({
        ...prev,
        [field]: { provider: field, has_key: false, updatedAt: 0 }
      }));
      setInputs((prev) => ({ ...prev, [field]: "" }));
      setApiMessage({
        type: "success",
        text: `${PROVIDER_LABELS[field]} API key removed.`,
        provider: field
      });
    } catch (e: unknown) {
      setApiMessage({
        type: "error",
        text: getErrorMessage(e),
        provider: field
      });
    } finally {
      setSaving(null);
    }
  };

  const modelOptions = provider === "local" ? localModels.filter((m) => m.enabled).map((m) => ({ id: m.modelId, label: m.displayName })) : PROVIDER_MODEL_OPTIONS[provider as Exclude<ProviderType, "local">] as readonly { id: string; label: string; badge?: string }[];

  return (
    <div className="space-y-4 font-sans text-xs text-foreground">
      {/* Segmented Tab Navigation */}
      <div className="flex rounded-xl bg-muted p-1 border border-border">
        <button
          type="button"
          onClick={() => setActiveTab("general")}
          className={`flex-1 rounded-lg py-1.5 font-mono text-[11px] font-medium transition-all ${
            activeTab === "general"
              ? "bg-card text-foreground border border-border shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Preferences
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("keys")}
          className={`flex-1 rounded-lg py-1.5 font-mono text-[11px] font-medium transition-all ${
            activeTab === "keys"
              ? "bg-card text-foreground border border-border shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          API Keys
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("models")}
          className={`flex-1 rounded-lg py-1.5 font-mono text-[11px] font-medium transition-all ${
            activeTab === "models"
              ? "bg-card text-foreground border border-border shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Models
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("usage")}
          className={`flex-1 rounded-lg py-1.5 font-mono text-[11px] font-medium transition-all ${
            activeTab === "usage"
              ? "bg-card text-foreground border border-border shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Usage
        </button>
      </div>

      {/* TAB 1: PREFERENCES */}
      {activeTab === "general" && (
        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
            <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
              Provider &amp; Model Selection
            </h4>
            
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderType)}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">Model</label>
              {provider === "local" && localModels.filter((m) => m.enabled).length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
                  No local models configured. Add one in the Models tab.
                </div>
              ) : (
                <select
                  value={modelOptions.some((m) => m.id === model) ? model : (provider === "local" ? (modelOptions[0]?.id ?? "") : DEFAULT_PROVIDER_MODELS[provider as Exclude<ProviderType, "local">])}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {(m as { badge?: string; label: string }).badge ? `${m.label} (${(m as { badge?: string }).badge})` : m.label}
                    </option>
                  ))}
                </select>
              )}
              {provider === "local" && localModels.filter((m) => m.enabled).length === 0 && (
                <p className="text-[11px] font-mono text-amber-500">Local models are required to chat locally without cloud API keys.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-3.5 space-y-2.5 shadow-xs">
            <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
              Appearance
            </h4>
            <div className="flex rounded-xl bg-muted p-1 border border-border">
              {(["light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => void setTheme(t)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize transition-colors ${
                    theme === t
                      ? "bg-card text-foreground border border-border shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* TAB 2: API KEYS */}
      {activeTab === "keys" && (
        <div className="space-y-3">
          {KEY_FIELDS.map((field) => {
            const status = keyStatus[field];
            const label = PROVIDER_LABELS[field];
            const busy = saving === field || testing === field;
            const isConnected = status.has_key;
            const fieldMessage = apiMessage?.provider === field ? apiMessage : null;

            return (
              <div key={field} className="rounded-xl border border-border bg-card p-3.5 space-y-2.5 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground font-mono">{label}</span>
                  <span
                    className={`flex items-center gap-1.5 text-[10px] font-mono font-medium ${
                      isConnected ? "text-emerald-500 font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
                    {isConnected ? "Connected" : "Not connected"}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type={visible[field] ? "text" : "password"}
                    value={inputs[field]}
                    onChange={(e) =>
                      setInputs((prev) => ({ ...prev, [field]: e.target.value }))
                    }
                    placeholder={isConnected ? "•••••••••••••••• (Replace)" : "Enter API key"}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-xl border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring font-mono"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setVisible((prev) => ({ ...prev, [field]: !prev[field] }))
                    }
                    className="shrink-0 rounded-xl border border-border bg-muted px-2.5 py-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground"
                  >
                    {visible[field] ? "Hide" : "Show"}
                  </button>
                </div>

                {isConnected && status.updatedAt > 0 && (
                  <p className="text-[10px] font-mono text-muted-foreground">
                    Updated: {new Date(status.updatedAt).toLocaleDateString()}
                  </p>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleSaveKey(field)}
                    disabled={busy || !inputs[field].trim()}
                    className="rounded-xl bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity cursor-pointer"
                  >
                    {saving === field ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTestKey(field)}
                    disabled={busy || !inputs[field].trim()}
                    className="rounded-xl border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer"
                  >
                    {testing === field ? "Testing..." : "Test"}
                  </button>
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => void handleRemoveKey(field)}
                      disabled={busy}
                      className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {fieldMessage && (
                  <p
                    role="status"
                    className={`text-[11px] font-mono ${
                      fieldMessage.type === "success" ? "text-emerald-500 font-medium" : "text-destructive"
                    }`}
                  >
                    {fieldMessage.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* TAB 2.5: MODELS (LOCAL) */}
      {activeTab === "models" && (
        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
            <div className="flex items-center justify-between">
              <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">Local Models</h4>
              <button
                type="button"
                onClick={() => setShowAddLocal((v) => !v)}
                className="rounded-xl bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:opacity-90 cursor-pointer"
              >
                {showAddLocal ? "Cancel" : "+ Add Local Model"}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">Connect Nexuss to an AI model running on your computer via Ollama, LM Studio, vLLM or any OpenAI-compatible endpoint. No cloud API key required.</p>

            {showAddLocal && (
              <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Provider</label>
                  <select
                    value={localProviderType}
                    onChange={(e) => setLocalProviderType(e.target.value as LocalProviderType)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  >
                    {(Object.keys(LOCAL_PROVIDER_LABELS) as LocalProviderType[]).map((t) => (
                      <option key={t} value={t}>{LOCAL_PROVIDER_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Endpoint</label>
                  <input
                    value={localEndpoint}
                    onChange={(e) => setLocalEndpoint(e.target.value)}
                    placeholder="http://localhost:11434/v1"
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-mono text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                  <p className="text-[10px] font-mono text-muted-foreground">Examples: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), http://localhost:8000/v1 (vLLM)</p>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">API Key <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <input
                    type="password"
                    value={localApiKey}
                    onChange={(e) => setLocalApiKey(e.target.value)}
                    placeholder="Optional"
                    autoComplete="off"
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-mono text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleTestLocal()}
                  disabled={localTesting}
                  className="rounded-xl border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-30 cursor-pointer"
                >
                  {localTesting ? "Testing..." : "Test Connection"}
                </button>
                {localTestResult && (
                  <p className={`text-[11px] font-mono ${localTestResult.ok ? "text-emerald-500" : "text-destructive"}`}>{localTestResult.message}</p>
                )}
                {discoveredModels.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">Available Models</label>
                    <select
                      value={selectedModelId}
                      onChange={(e) => setSelectedModelId(e.target.value)}
                      className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                    >
                      {discoveredModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Model ID {discoveredModels.length > 0 ? <span className="font-normal text-muted-foreground">(or manual)</span> : null}</label>
                  <input
                    value={manualModelId}
                    onChange={(e) => setManualModelId(e.target.value)}
                    placeholder={discoveredModels.length > 0 ? "Or enter manually, e.g. llama3.2:3b" : "e.g. llama3.2:3b, qwen2.5:7b, mistral"}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-mono text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                  {discoveredModels.length === 0 && localTestResult?.ok && (
                    <p className="text-[10px] font-mono text-amber-500">Model discovery unavailable — enter the model ID manually.</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleAddLocal()}
                  disabled={localSaving}
                  className="rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-30 cursor-pointer"
                >
                  {localSaving ? "Adding..." : "Add Model"}
                </button>
                {localMessage && (
                  <p className={`text-[11px] font-mono ${localMessage.type === "success" ? "text-emerald-500" : "text-destructive"}`}>{localMessage.text}</p>
                )}
                <div className="rounded-lg bg-muted p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  <p className="font-semibold text-foreground">Quick setup (Ollama):</p>
                  <ol className="list-decimal list-inside mt-1 space-y-0.5 font-mono text-[10px]">
                    <li>Install Ollama from ollama.com</li>
                    <li>Run: <code className="rounded bg-background border border-border px-1 py-0.5">ollama pull llama3.2:3b</code></li>
                    <li>Ensure Ollama allows CORS: <code className="rounded bg-background border border-border px-1 py-0.5">OLLAMA_ORIGINS=* ollama serve</code></li>
                    <li>Add endpoint <code className="rounded bg-background border border-border px-1 py-0.5">http://localhost:11434/v1</code> and test</li>
                  </ol>
                </div>
              </div>
            )}

            {!localHydrated ? (
              <p className="text-[11px] font-mono text-muted-foreground">Loading local models...</p>
            ) : localProviders.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-6 text-center">
                <p className="text-xs font-medium text-foreground">No local models yet</p>
                <p className="text-[11px] text-muted-foreground mt-1">Add your first local endpoint to chat without cloud keys.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {localProviders.map((prov) => {
                  const modelsForProv = localModels.filter((m) => m.providerId === prov.id);
                  const isEditing = editingProviderId === prov.id;
                  return (
                    <div key={prov.id} className="rounded-xl border border-border bg-muted/20 p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-bold font-mono text-foreground truncate">{prov.name} <span className="font-normal text-muted-foreground">({LOCAL_PROVIDER_LABELS[prov.providerType]})</span></p>
                          <p className="text-[11px] font-mono text-muted-foreground truncate">{prov.endpoint}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-mono font-medium ${prov.enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{prov.enabled ? "Enabled" : "Disabled"}</span>
                      </div>
                      {isEditing ? (
                        <div className="space-y-2 rounded-lg border border-border bg-card p-2.5">
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name" className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none" />
                          <input value={editEndpoint} onChange={(e) => setEditEndpoint(e.target.value)} placeholder="Endpoint" className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs font-mono outline-none" />
                          <div className="flex gap-2">
                            <button onClick={async () => {
                              const err = validateEndpoint(editEndpoint);
                              if (err) { setLocalMessage({ type: "error", text: err }); return; }
                              await updateLocalProvider(prov.id, { name: editName.trim() || prov.name, endpoint: editEndpoint });
                              setEditingProviderId(null);
                            }} className="rounded-lg bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold cursor-pointer">Save</button>
                            <button onClick={() => setEditingProviderId(null)} className="rounded-lg border border-border bg-background px-3 py-1 text-xs cursor-pointer">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              const res = await testLocalEndpoint(prov.endpoint, prov.providerType, prov.apiKey);
                              setLocalMessage({ type: res.ok ? "success" : "error", text: `${prov.name}: ${res.message}` });
                            }}
                            className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-mono hover:bg-muted cursor-pointer"
                          >
                            Test
                          </button>
                          <button onClick={() => { setEditingProviderId(prov.id); setEditEndpoint(prov.endpoint); setEditName(prov.name); }} className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-mono hover:bg-muted cursor-pointer">Edit</button>
                          <button onClick={() => void removeLocalProvider(prov.id)} className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-mono text-destructive hover:bg-destructive/20 cursor-pointer">Remove</button>
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">Models ({modelsForProv.length})</p>
                        {modelsForProv.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">No models added for this endpoint.</p>
                        ) : (
                          modelsForProv.map((m) => (
                            <div key={m.id} className="flex items-center justify-between rounded-lg border border-border bg-card px-2.5 py-2">
                              <div className="min-w-0">
                                <p className="text-xs font-mono font-medium truncate">{m.displayName}</p>
                                <p className="text-[10px] font-mono text-muted-foreground truncate">{m.modelId}</p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button onClick={() => void toggleLocalModel(m.id, !m.enabled)} className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${m.enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{m.enabled ? "Enabled" : "Disabled"}</button>
                                <button onClick={() => void removeLocalModel(m.id)} className="rounded-lg border border-border bg-muted px-2 py-1 text-[10px] font-mono hover:bg-card cursor-pointer">Remove</button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {localMessage && <p className={`text-[11px] font-mono ${localMessage.type === "success" ? "text-emerald-500" : "text-destructive"}`}>{localMessage.text}</p>}
          </section>
        </div>
      )}

      {/* TAB 3: USAGE */}
      {activeTab === "usage" && (
        <section>
          <UsageDashboard />
        </section>
      )}
    </div>
  );
}
