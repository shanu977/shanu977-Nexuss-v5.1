"use client";

import { useEffect, useState } from "react";
import { ProviderType } from "@/types";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_MODEL_OPTIONS
} from "@/types/providers";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { useChatStore } from "@/store";
import { apiKeyService, ApiKeyStatus } from "@/services/apiKeys";
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
  const providers: ProviderType[] = ["groq", "gemini", "openrouter"];

  const [activeTab, setActiveTab] = useState<"general" | "keys" | "usage">("general");

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
    } catch (e: any) {
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
    } catch (e: any) {
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
    } catch (e: any) {
      setApiMessage({
        type: "error",
        text: getErrorMessage(e),
        provider: field
      });
    } finally {
      setSaving(null);
    }
  };

  const modelOptions = PROVIDER_MODEL_OPTIONS[provider];

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
              <select
                value={modelOptions.some((m) => m.id === model) ? model : DEFAULT_PROVIDER_MODELS[provider]}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.badge ? `${m.label} (${m.badge})` : m.label}
                  </option>
                ))}
              </select>
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

      {/* TAB 3: USAGE */}
      {activeTab === "usage" && (
        <section>
          <UsageDashboard />
        </section>
      )}
    </div>
  );
}
