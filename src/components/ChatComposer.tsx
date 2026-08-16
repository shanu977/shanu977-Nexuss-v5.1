"use client";

import { useState, useRef, useEffect } from "react";
import Spinner from "@/components/Spinner";
import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import {
  getModelLabel,
  PROVIDER_LIST,
  PROVIDER_MODEL_OPTIONS,
  type ProviderType
} from "@/types/providers";
import {
  SendIcon,
  PlusIcon,
  ChevronDownIcon,
  CheckIcon,
  FolderIcon,
  MonitorIcon
} from "@/components/icons";

interface ChatComposerProps {
  onSend: (content: string) => Promise<void>;
  loading: boolean;
  disabled?: boolean;
  onStartScreenShare?: () => void;
}

export default function ChatComposer({
  onSend,
  loading,
  disabled,
  onStartScreenShare
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
    <form onSubmit={handleSubmit} className="shrink-0 bg-background p-3 sm:p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {/* Floating Composer Container */}
        <div className="flex flex-col rounded-3xl border border-border bg-card p-2.5 shadow-lg transition-all duration-150">
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
          />

          {/* Composer Footer Bar */}
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/80 px-2 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <AttachMenu onStartScreenShare={onStartScreenShare} />
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

            {/* Send Button */}
            <button
              type="submit"
              disabled={blocked || !text.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
              title="Send message"
              aria-label="Send message"
            >
              {loading ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <SendIcon className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Shortcuts notice */}
        <p className="text-center text-[10px] font-mono text-muted-foreground opacity-80">
          Enter to send • Shift+Enter for newline
        </p>
      </div>
    </form>
  );
}

interface AttachMenuProps {
  onStartScreenShare?: () => void;
}

function AttachMenu({ onStartScreenShare }: AttachMenuProps) {
  const [open, setOpen] = useState(false);
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

  const handleShareScreen = () => {
    setOpen(false);
    onStartScreenShare?.();
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add attachment"
        title="Add attachment"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
      >
        <PlusIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Add attachment"
          className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-2xl animate-fade-in text-popover-foreground"
        >
          {/* Path is a FUTURE feature: placeholder only, no behavior. */}
          <button
            type="button"
            role="menuitem"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground opacity-60"
          >
            <FolderIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">Path</span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wide text-muted-foreground">
              Soon
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleShareScreen}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted cursor-pointer"
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

  const handleSelect = (p: ProviderType, m: string) => {
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
          {PROVIDER_LIST.map((p) => (
            <div key={p} className="mb-1">
              <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground font-mono">
                {PROVIDER_LABELS[p]}
              </div>
              <div className="space-y-0.5">
                {PROVIDER_MODEL_OPTIONS[p].map((m) => {
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
