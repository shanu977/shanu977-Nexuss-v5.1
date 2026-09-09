"use client";

import { useState, useRef, useEffect } from "react";
import { useChatStore } from "@/store";
import { useLocalModelStore } from "@/store/localModelStore";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import {
  getModelLabel,
  PROVIDER_LIST,
  PROVIDER_MODEL_OPTIONS,
  type ProviderType
} from "@/types/providers";
import {
  SendIcon,
  SquareIcon,
  PlusIcon,
  ChevronDownIcon,
  CheckIcon,
  TerminalIcon,
  MonitorIcon
} from "@/components/icons";
import { useWorkspaceStore } from "@/workspace/store";

interface ChatComposerProps {
  onSend: (content: string) => Promise<void>;
  onStop?: () => void;
  loading: boolean;
  disabled?: boolean;
  onStartScreenShare?: () => void;
  onOpenWorkspace?: () => void;
}

export default function ChatComposer({
  onSend,
  onStop,
  loading,
  disabled,
  onStartScreenShare,
  onOpenWorkspace
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const fallbackNotice = useChatStore((s) => s.fallbackNotice);

  useEffect(() => {
    if (!loading && !disabled) {
      textareaRef.current?.focus();
    }
  }, [loading, disabled]);

  const blocked = !!loading || !!disabled;

  // Space reserved at the bottom of the composer for the on-screen keyboard
  // (iOS Safari) plus the home-indicator safe area on notched devices.
  const keyboardInset = useKeyboardInset();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || blocked) return;
    setText("");
    await onSend(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="shrink-0 bg-background p-3 sm:p-4 dark:bg-[#0f0f0f]"
      style={
        keyboardInset > 0
          ? {
              paddingBottom: `calc(${keyboardInset}px + env(safe-area-inset-bottom, 0px))`
            }
          : undefined
      }
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {/* Typing box — borderless and flat, no shadow. ONLY this area gets
            the card background; the controls bar below stays flat. */}
        <div className="flex flex-col rounded-3xl bg-card p-2.5 transition-all duration-150">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What’s the mission?"
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 py-2 text-xs font-sans leading-relaxed text-foreground placeholder-muted-foreground outline-none"
            rows={Math.min(4, Math.max(1, Math.ceil(text.length / 80)))}
            disabled={blocked}
            aria-label="Message input"
            style={{ outline: "none" }}
          />
        </div>

        {/* Composer Controls Bar — unchanged, no shadow/border */}
        <div className="flex items-center justify-between gap-2 px-2">
          <div className="flex min-w-0 items-center gap-2">
            <AttachMenu
              onStartScreenShare={onStartScreenShare}
              onOpenWorkspace={onOpenWorkspace}
            />
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <ModelSelector
                provider={provider}
                model={model}
                disabled={blocked}
              />
              {fallbackNotice && (
                <span className="truncate text-[10px] font-mono text-amber-500 font-medium">
                  {fallbackNotice}
                </span>
              )}
            </div>
          </div>

          {/* Send / Stop Button — during generation the Send button becomes a
              Stop button that aborts the active request. It stays enabled so it
              is always tappable; the partial response is preserved on stop. */}
          {blocked ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition-all hover:opacity-90 active:scale-95 cursor-pointer"
              title="Stop generating"
              aria-label="Stop generating"
            >
              <SquareIcon className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!text.trim()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
              title="Send message"
              aria-label="Send message"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Shortcuts notice */}
        <p className="text-center text-[10px] font-mono text-muted-foreground opacity-80">
        </p>
      </div>
    </form>
  );
}

interface AttachMenuProps {
  onStartScreenShare?: () => void;
  onOpenWorkspace?: () => void;
}

function AttachMenu({ onStartScreenShare, onOpenWorkspace }: AttachMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelOpen = useWorkspaceStore((s) => s.panelOpen);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleShareScreen = () => {
    setOpen(false);
    onStartScreenShare?.();
  };

  const handleOpenWorkspace = () => {
    setOpen(false);
    // Terminal panel: clicking always opens/toggles the terminal workspace.
    // No folder picker, no connection gate — terminal is ready immediately.
    onOpenWorkspace?.();
  };
  // Terminal active when the panel is open (visibility is source of truth)
  const pathActive = panelOpen;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add attachment"
        title="Add attachment"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
      >
        <PlusIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Add attachment"
          className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-2xl animate-fade-in text-popover-foreground"
        >
          {/* Terminal — single toggle for agent workspace/terminal access */}
          <button
            type="button"
            role="menuitem"
            onClick={handleOpenWorkspace}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition-colors cursor-pointer ${pathActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}
            aria-pressed={pathActive}
          >
            <TerminalIcon className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">Terminal</span>
            {pathActive && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleShareScreen}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-muted cursor-pointer"
          >
            <MonitorIcon className="h-4 w-4 shrink-0 text-primary" />
            Share Screen
          </button>
        </div>
      )}
    </div>
  );
}

interface ModelSelectorProps {
  provider: ProviderType;
  model: string;
  disabled: boolean;
}

function ModelSelector({ provider, model, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);
  const localModels = useLocalModelStore((s) => s.models.filter((m) => m.enabled));
  const discoveredOllamaModels = useLocalModelStore((s) => s.discoveredOllamaModels);
  const ollamaStatus = useLocalModelStore((s) => s.ollamaStatus);
  const ollamaError = useLocalModelStore((s) => s.ollamaError);
  const refreshOllamaModels = useLocalModelStore((s) => s.refreshOllamaModels);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Auto-discover Ollama models when Local section is opened
    // Do not fetch in production web (will return production message)
    void refreshOllamaModels();
  }, [open, refreshOllamaModels]);

  const handleSelect = async (p: ProviderType, m: string) => {
    if (p === "local") {
      // Ensure the selected discovered model is persisted as a LocalModel for future
      const discovered = useLocalModelStore.getState().discoveredOllamaModels.find((d) => d.modelId === m);
      const existing = useLocalModelStore.getState().models.find((mod) => mod.modelId === m);
      if (discovered && !existing) {
        const ollamaProvider = useLocalModelStore.getState().providers.find((pr) => pr.providerType === "ollama");
        if (ollamaProvider) {
          try {
            await useLocalModelStore.getState().addModel(ollamaProvider.id, m, m);
          } catch {}
        } else {
          // No Ollama provider yet, create one and add model
          try {
            const newProv = await useLocalModelStore.getState().addProvider({
              name: "Ollama",
              providerType: "ollama",
              endpoint: "http://localhost:11434/v1",
            });
            await useLocalModelStore.getState().addModel(newProv.id, m, m);
          } catch {}
        }
      }
      // If selected model is not in discovered list, clear invalid selection
      const stillExists = useLocalModelStore.getState().discoveredOllamaModels.some((d) => d.modelId === m) || useLocalModelStore.getState().models.some((mod) => mod.modelId === m);
      if (!stillExists && m) {
        // Keep the invalid selection but show warning; do not silently switch
      }
    }
    if (p !== provider) setProvider(p);
    setModel(m);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Select model"
        className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-[10px] font-mono text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
      >
        <span className="max-w-[140px] truncate">
          {PROVIDER_LABELS[provider]} • {getModelLabel(provider, model)}
        </span>
        <ChevronDownIcon
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Choose model"
          className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-2xl animate-fade-in text-popover-foreground"
        >
          {/* Local models first-class — dynamic Ollama discovery */}
          <div className="mb-1">
            <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground font-mono flex items-center gap-1.5">
              Ollama
              {ollamaStatus === "connected" && <span className="flex items-center gap-1 text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected</span>}
              {ollamaStatus === "loading" && <span className="text-muted-foreground">Loading…</span>}
            </div>
            {ollamaStatus === "not_connected" || ollamaStatus === "error" ? (
              <div className="px-2.5 py-2 space-y-1.5">
                <p className="text-[11px] text-amber-600 dark:text-amber-400">⚠ Ollama is not connected</p>
                <p className="text-[11px] text-muted-foreground">Start Ollama and try again. {ollamaError ? `(${ollamaError})` : ""}</p>
                <button
                  type="button"
                  onClick={() => void refreshOllamaModels()}
                  className="rounded-lg border border-border bg-muted px-2.5 py-1 text-[11px] font-mono hover:bg-card cursor-pointer"
                >
                  Refresh Models
                </button>
              </div>
            ) : (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {discoveredOllamaModels.length > 0 ? `Models: ${discoveredOllamaModels.length}` : ollamaStatus === "loading" ? "Discovering…" : `Local • ${localModels.length} saved`}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshOllamaModels()}
                    className="rounded-lg border border-border bg-muted px-2 py-0.5 text-[10px] font-mono hover:bg-card cursor-pointer"
                  >
                    Refresh Models
                  </button>
                </div>
                {(discoveredOllamaModels.length > 0 ? discoveredOllamaModels : localModels.map((m) => ({ id: m.id, modelId: m.modelId, size: m.size, family: m.family, parameterSize: m.parameterSize }))).length === 0 ? (
                  <div className="px-2.5 py-2 text-[11px] text-muted-foreground">No local models. Add one in Settings → Models or start Ollama.</div>
                ) : (
                  (discoveredOllamaModels.length > 0 ? discoveredOllamaModels : localModels.map((m) => ({ id: m.id, modelId: m.modelId, size: m.size, family: m.family, parameterSize: m.parameterSize }))).map((m) => {
                    const modelId = (m as { modelId: string }).modelId;
                    const selected = provider === "local" && modelId === model;
                    const isStale = provider === "local" && model === modelId && !discoveredOllamaModels.some((d) => d.modelId === model) && discoveredOllamaModels.length > 0;
                    return (
                      <button
                        key={modelId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => void handleSelect("local", modelId)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                          selected ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{modelId}</span>
                          {(m as { size?: number; family?: string; parameterSize?: string }).size || (m as { family?: string }).family ? (
                            <span className="block truncate text-[10px] font-mono text-muted-foreground">
                              {(m as { family?: string }).family ? `${(m as { family?: string }).family} ` : ""}
                              {(m as { parameterSize?: string }).parameterSize ? `${(m as { parameterSize?: string }).parameterSize} ` : ""}
                              {(m as { size?: number }).size ? `${(((m as { size?: number }).size as number) / 1e9).toFixed(1)}GB` : ""}
                            </span>
                          ) : null}
                          {isStale && <span className="block text-[10px] text-amber-600">Selected model no longer installed – pick another.</span>}
                        </span>
                        {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })
                )}
                {provider === "local" && model && discoveredOllamaModels.length > 0 && !discoveredOllamaModels.some((d) => d.modelId === model) && (
                  <div className="px-2.5 py-1 text-[11px] text-amber-600">Selected model “{model}” no longer installed. Please select another.</div>
                )}
              </div>
            )}
          </div>
          {PROVIDER_LIST.filter((p) => p !== "local").map((p) => (
            <div key={p} className="mb-1">
              <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground font-mono">
                {PROVIDER_LABELS[p]}
              </div>
              <div className="space-y-0.5">
                {PROVIDER_MODEL_OPTIONS[p as Exclude<ProviderType, "local">].map((m) => {
                  const selected = p === provider && m.id === model;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => handleSelect(p, m.id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                        selected
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {m.label}
                          {m.badge ? (
                            <span className="ml-1.5 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-mono font-semibold text-emerald-500">
                              {m.badge}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
