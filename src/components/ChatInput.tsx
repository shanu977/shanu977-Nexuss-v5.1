"use client";

import { useState, useRef, useEffect } from "react";
import Spinner from "@/components/Spinner";
import { useChatStore } from "@/store";
import { PROVIDER_LABELS } from "@/utils/providerLabels";
import { getModelLabel, type ProviderType } from "@/types/providers";

interface ChatInputProps {
  onSend: (content: string) => Promise<void>;
  loading: boolean;
  disabled?: boolean;
}

export default function ChatInput({ onSend, loading, disabled }: ChatInputProps) {
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

  const blocked = loading || disabled;

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
      void handleSubmit(e as any);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="shrink-0 bg-background p-3 border-t border-border sm:p-4 transition-colors">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {/* Floating Composer Container */}
        <div className="flex flex-col rounded-2xl border border-border bg-card p-2.5 shadow-lg focus-within:border-ring focus-within:ring-1 focus-within:ring-ring transition-all duration-150">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask NEXUSS AI... (Shift+Enter for new line)"
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 py-2 text-xs font-sans text-foreground placeholder-muted-foreground outline-none leading-relaxed"
            rows={Math.min(4, Math.max(1, Math.ceil(text.length / 80)))}
            disabled={blocked}
            aria-label="Message input"
          />

          {/* Composer Footer Bar */}
          <div className="flex items-center justify-between border-t border-border/80 pt-2 px-2 mt-1">
            {/* Active Model Indicator Pill */}
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="rounded-lg border border-border bg-muted px-2.5 py-1 text-[10px] font-mono text-muted-foreground">
                Model: <strong className="text-foreground font-semibold">{PROVIDER_LABELS[provider]}</strong> • {getModelLabel(provider as ProviderType, model)}
              </span>
              {fallbackNotice && (
                <span className="truncate text-[10px] font-mono text-amber-500 font-medium">
                  {fallbackNotice}
                </span>
              )}
            </div>

            {/* Send Button */}
            <button
              type="submit"
              disabled={blocked || !text.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold shadow-xs hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30 active:scale-95 cursor-pointer transition-all"
              title="Send message"
              aria-label="Send message"
            >
              {loading ? <Spinner className="h-3.5 w-3.5" /> : <span className="text-xs">➤</span>}
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
