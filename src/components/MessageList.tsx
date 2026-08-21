"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Message } from "@/types";
import { useChatStore } from "@/store";
import { NexussLogo } from "@/components/admin/NexussLogo";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  isStreaming: boolean;
  streamingMessageId: string | null;
  onSendSuggestion?: (content: string) => Promise<void>;
  screenShareActive?: boolean;
  captureScreenFrame?: () => string | null;
}

interface MessageActionProps {
  message: Message;
  streaming: boolean;
  isEditing: boolean;
  draft: string;
  copied: boolean;
  busy: boolean;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onStartEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (message: Message) => void;
  onCopy: (message: Message) => void;
  onRegenerate: (message: Message) => void;
}

export default function MessageList({
  messages,
  loading,
  isStreaming,
  streamingMessageId,
  onSendSuggestion,
  screenShareActive,
  captureScreenFrame
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const editMessageAndRegenerate = useChatStore((s) => s.editMessageAndRegenerate);
  const regenerateResponse = useChatStore((s) => s.regenerateResponse);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Tracks whether the user is at/near the bottom of the conversation. Manual
  // scrolling always wins: once the user scrolls beyond the threshold, auto-
  // following stops and only resumes when they come back to the bottom.
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isGenerating = loading || isStreaming;
  const prevFirstIdRef = useRef<string | undefined>(undefined);
  const prevLengthRef = useRef(0);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom < 120;
    setIsNearBottom((prev) => (prev === near ? prev : near));
  }, []);

  // Scroll policy:
  // - A different conversation loading in always lands on the newest message.
  // - A new message appended while the user is still near the bottom scrolls
  //   down so the reply is visible.
  // - While generating, streamed content only keeps the view pinned to the
  //   bottom when the user is already there. If the user scrolls away, their
  //   position is never overridden until they return to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    const length = messages.length;
    const chatSwitched = firstId !== undefined && firstId !== prevFirstIdRef.current;
    const messageAdded = length > prevLengthRef.current;
    prevFirstIdRef.current = firstId;
    prevLengthRef.current = length;

    if (chatSwitched) {
      el.scrollTop = el.scrollHeight;
    } else if (messageAdded && isNearBottom) {
      el.scrollTop = el.scrollHeight;
    } else if (isGenerating && isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isGenerating, isNearBottom]);

  const copyTimer = useRef<number | null>(null);

  // The edit draft is read through a ref so `saveEdit` keeps a stable identity
  // while the user types, which lets memoized message rows stay memoized.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const handleCopy = useCallback(async (msg: Message) => {
    try {
      await navigator.clipboard.writeText(msg.content);
    } catch {
      // Fallback for browsers/non-secure contexts without the async clipboard.
      try {
        const ta = document.createElement("textarea");
        ta.value = msg.content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        return; // clipboard unavailable; do not corrupt state
      }
    }
    setCopiedId(msg.id);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopiedId((id) => (id === msg.id ? null : id));
    }, 2000);
  }, []);

  const startEdit = useCallback((msg: Message) => {
    setEditingId(msg.id);
    setDraft(msg.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft("");
  }, []);

  const saveEdit = useCallback(
    async (msg: Message) => {
      const content = draftRef.current.trim();
      if (!content) return;
      setBusyId(msg.id);
      try {
        // While screen sharing is active, attach exactly one fresh frame taken
        // at send time so the edited question is answered with the current screen.
        const image =
          screenShareActive && captureScreenFrame
            ? (captureScreenFrame() ?? undefined)
            : undefined;
        await editMessageAndRegenerate(msg.id, content, image);
      } finally {
        setBusyId(null);
      }
      setEditingId(null);
      setDraft("");
    },
    [screenShareActive, captureScreenFrame, editMessageAndRegenerate]
  );

  const handleRegenerate = useCallback(
    async (msg: Message) => {
      setBusyId(msg.id);
      try {
        // Same rule as edit/send: one fresh frame per regenerate while sharing.
        const image =
          screenShareActive && captureScreenFrame
            ? (captureScreenFrame() ?? undefined)
            : undefined;
        await regenerateResponse(msg.id, image);
      } finally {
        setBusyId(null);
      }
    },
    [screenShareActive, captureScreenFrame, regenerateResponse]
  );

  const blocked = loading || isStreaming;

if (messages.length === 0 && !loading && !isStreaming) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <NexussLogo size={64} className="mb-4" />
        <h2 className="text-xl font-bold tracking-tight text-foreground font-sans">
          What&apos;s on your mind today?
        </h2>
        <p className="mt-2 max-w-md text-xs text-muted-foreground font-sans leading-relaxed">
          Ask technical questions, generate clean code, analyze complex architectures, or debug your code with NEXUSS AI.
        </p>
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
        {messages.map((msg) => (
          <MessageItem
            key={msg.id}
            message={msg}
            streaming={isStreaming && msg.id === streamingMessageId}
            isEditing={editingId === msg.id}
            draft={editingId === msg.id ? draft : msg.content}
            copied={copiedId === msg.id}
            busy={busyId === msg.id}
            disabled={blocked}
            onDraftChange={setDraft}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSaveEdit={saveEdit}
            onCopy={handleCopy}
            onRegenerate={handleRegenerate}
          />
        ))}

        {/* Thinking indicator — shown while the request is starting, before
            streaming begins. */}
        {loading && !isStreaming && (
          <div className="flex items-center gap-3 self-start max-w-[90%]">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card border border-border">
              <img src="/nexuss-logo.png" alt="NEXUSS" className="w-4 h-4 object-contain" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
              <ThinkingIndicator />
            </div>
          </div>
        )}

        <div className="h-px" />
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem(props: MessageActionProps) {
  const {
    message,
    streaming,
    isEditing,
    draft,
    copied,
    busy,
    disabled,
    onDraftChange,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onCopy,
    onRegenerate
  } = props;
  const isAssistant = message.role === "assistant";
  const actionsDisabled = disabled || busy;

  return (
    <div
      className={`flex w-full items-start gap-3 animate-message-in ${
        isAssistant ? "justify-start" : "justify-end"
      }`}
    >
      {isAssistant && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card border border-border mt-1">
          <img src="/nexuss-logo.png" alt="NEXUSS" className="w-4 h-4 object-contain" />
        </div>
      )}

      <div className="flex min-w-0 max-w-[85%] flex-col">
        {isEditing && !isAssistant ? (
          <div className="rounded-2xl rounded-tr-sm border border-border bg-card p-3">
            <textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSaveEdit(message);
                }
                if (e.key === "Escape") {
                  onCancelEdit();
                }
              }}
              autoFocus
              rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 60)))}
              aria-label="Edit message"
              className="max-h-48 w-full resize-none bg-transparent px-1 py-1 text-xs font-sans text-foreground placeholder-muted-foreground outline-none leading-relaxed"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={busy}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 cursor-pointer"
                title="Cancel editing (Esc)"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onSaveEdit(message)}
                disabled={busy || !draft.trim()}
                className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-mono font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
                title="Send edited message (Enter)"
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <div
            className={
              isAssistant
                ? "text-xs leading-relaxed text-foreground"
                : "rounded-2xl rounded-tr-sm border border-border bg-secondary px-4 py-3 text-xs leading-relaxed text-secondary-foreground"
            }
          >
            {/* While waiting for the first content chunk the streaming assistant
                message shows the thinking indicator in place; the first visible
                chunk replaces it with the actual text. */}
            {streaming && message.content.trim() === "" ? (
              <div className="flex items-center gap-2 px-4 py-3">
                <ThinkingIndicator />
              </div>
            ) : (
              <MessageContent content={message.content} isAssistant={isAssistant} />
            )}
            {/* Blinking cursor on the assistant message while content is streaming. */}
            {streaming && message.content.trim() !== "" && (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-primary align-middle"
              />
            )}
            <p className="mt-2 text-right text-[10px] font-mono text-muted-foreground/70">
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit"
              })}
            </p>
          </div>
        )}

        {/* Action row */}
        {!isEditing && (
          <div
            className={`mt-1 flex items-center gap-1 ${
              isAssistant ? "justify-start" : "justify-end"
            }`}
          >
            <ActionButton
              onClick={() => onCopy(message)}
              disabled={actionsDisabled}
              label={copied ? "Copied" : "Copy message"}
              title={copied ? "Copied" : "Copy message"}
            >
              {copied ? (
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </ActionButton>

            {isAssistant ? (
              <ActionButton
                onClick={() => onRegenerate(message)}
                disabled={actionsDisabled}
                label="Regenerate response"
                title="Regenerate response"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </ActionButton>
            ) : (
              <ActionButton
                onClick={() => onStartEdit(message)}
                disabled={actionsDisabled}
                label="Edit message"
                title="Edit message"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
      </div>
      <span className="text-xs font-mono text-muted-foreground">Nexuss is thinking...</span>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  label,
  title,
  children
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
    >
      {children}
    </button>
  );
}

interface MessageContentProps {
  content: string;
  isAssistant: boolean;
}

function MessageContent({ content, isAssistant }: MessageContentProps) {
  if (isAssistant) {
    return (
      <div className="prose dark:prose-invert prose-xs max-w-none prose-p:leading-relaxed prose-pre:m-0 font-sans">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: CodeBlock,
            pre: PreBlock,
            table: TableBlock
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
  return <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>;
}

function TableBlock(props: any) {
  const { node, ...tableProps } = props;
  // The `node` object is react-markdown plumbing and must never reach the DOM.
  void node;
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table {...tableProps} className="w-full text-left text-xs" />
    </div>
  );
}

function CodeBlock({ node, ...props }: any) {
  const isInline = node?.position?.start.line === node?.position?.end.line;
  if (isInline) {
    return <code {...props} className="rounded bg-muted border border-border px-1.5 py-0.5 text-[11px] font-mono text-emerald-600 dark:text-emerald-400" />;
  }
  return <pre {...props} className="my-2 overflow-x-auto rounded-lg bg-muted border border-border p-3 text-xs font-mono" />;
}

function PreBlock({ children }: any) {
  const [copied, setCopied] = useState(false);
  const codeString =
    typeof children === "string" ? children : String(children?.props?.children || "");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3">
      <button
        onClick={handleCopy}
        className="absolute right-2.5 top-2.5 rounded bg-background border border-border px-2 py-1 text-[10px] font-mono text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 cursor-pointer"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
      <SyntaxHighlighter
        language="typescript"
        style={oneDark}
        className="overflow-x-auto rounded-xl bg-card border border-border text-xs font-mono"
        showLineNumbers={false}
        customStyle={{
          margin: 0,
          padding: "1rem",
          borderRadius: "0.75rem",
        }}
      >
        {codeString}
      </SyntaxHighlighter>
    </div>
  );
}
