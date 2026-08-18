"use client";

import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { AdMeshRecommendations } from "admesh-ui-sdk";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Message } from "@/types";
import { useChatStore } from "@/store";
import { isAdMeshProviderMounted } from "@/lib/admesh";

interface AdMeshContext {
  messageId: string;
  query: string;
}

function assistantAdMeshContext(
  messages: Message[],
  index: number
): AdMeshContext | null {
  const msg = messages[index];
  if (!msg || msg.role !== "assistant") return null;
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.role === "user" && prev.chatId === msg.chatId) {
      const query = prev.content.trim();
      if (query) return { messageId: prev.id, query };
    }
  }
  return null;
}

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  isStreaming: boolean;
  streamingMessage: string;
  onSendSuggestion?: (content: string) => Promise<void>;
  screenShareActive?: boolean;
  captureScreenFrame?: () => string | null;
}

const SUGGESTIONS = [
  {
    title: "Write code",
    prompt: "Write a clean TypeScript utility for exponential backoff retries with async/await.",
    icon: "💻"
  },
  {
    title: "Explain concepts",
    prompt: "Explain the architectural difference between WebSockets and Server-Sent Events (SSE).",
    icon: "💡"
  },
  {
    title: "Analyze data",
    prompt: "How can I profile and fix memory leaks or unnecessary re-renders in a large React application?",
    icon: "📊"
  },
  {
    title: "Brainstorm ideas",
    prompt: "Brainstorm a scalable architecture for an AI agent platform with background workers.",
    icon: "⚡"
  }
];

interface MessageActionProps {
  message: Message;
  adMesh: AdMeshContext | null;
  isEditing: boolean;
  draft: string;
  copied: boolean;
  busy: boolean;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
}

export default function MessageList({
  messages,
  loading,
  isStreaming,
  streamingMessage,
  onSendSuggestion,
  screenShareActive,
  captureScreenFrame
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const editMessageAndRegenerate = useChatStore((s) => s.editMessageAndRegenerate);
  const regenerateResponse = useChatStore((s) => s.regenerateResponse);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming, streamingMessage]);

  const copyTimer = useRef<number | null>(null);

  const handleCopy = async (msg: Message) => {
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
  };

  const startEdit = (msg: Message) => {
    setEditingId(msg.id);
    setDraft(msg.content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  const saveEdit = async (msg: Message) => {
    const content = draft.trim();
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
  };

  const handleRegenerate = async (msg: Message) => {
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
  };

  const blocked = loading || isStreaming;

  if (messages.length === 0 && !loading && !isStreaming) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        {/* Emblem */}
        <div className="relative mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card shadow-md">
          <img
            src="/nexuss-logo.png"
            alt="NEXUSS Logo"
            className="h-8 w-8 object-contain"
          />
        </div>
        <h2 className="text-xl font-bold tracking-tight text-foreground font-sans">
          What&apos;s on your mind today?
        </h2>
        <p className="mt-2 max-w-md text-xs text-muted-foreground font-sans leading-relaxed">
          Ask technical questions, generate clean code, analyze complex architectures, or debug your code with NEXUSS AI.
        </p>

        {/* Suggestion Cards */}
        <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 text-left sm:grid-cols-2">
          {SUGGESTIONS.map((item) => (
            <button
              key={item.title}
              onClick={() => void onSendSuggestion?.(item.prompt)}
              className="flex flex-col justify-between rounded-xl border border-border bg-card p-3.5 text-left shadow-xs transition-all duration-150 hover:bg-muted/70 hover:border-ring/30 group cursor-pointer"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-sm">{item.icon}</span>
                <span className="text-xs font-semibold text-foreground font-mono">
                  {item.title}
                </span>
              </div>
              <p className="line-clamp-2 text-[11px] text-muted-foreground leading-relaxed font-sans">
                {item.prompt}
              </p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
        {messages.map((msg, i) => (
          <MessageItem
            key={msg.id}
            message={msg}
            adMesh={assistantAdMeshContext(messages, i)}
            isEditing={editingId === msg.id}
            draft={editingId === msg.id ? draft : msg.content}
            copied={copiedId === msg.id}
            busy={busyId === msg.id}
            disabled={blocked}
            onDraftChange={setDraft}
            onStartEdit={() => startEdit(msg)}
            onCancelEdit={cancelEdit}
            onSaveEdit={() => void saveEdit(msg)}
            onCopy={() => void handleCopy(msg)}
            onRegenerate={() => void handleRegenerate(msg)}
          />
        ))}

        {isStreaming && (
          <div className="flex self-start w-full max-w-[90%] gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card border border-border shadow-xs">
              <img src="/nexuss-logo.png" alt="NEXUSS" className="w-4 h-4 object-contain" />
            </div>
            <div className="flex-1 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-xs">
              <StreamingContent content={streamingMessage} />
              <div className="mt-2.5 flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {loading && !isStreaming && (
          <div className="flex items-center gap-3 self-start max-w-[90%]">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card border border-border shadow-xs">
              <img src="/nexuss-logo.png" alt="NEXUSS" className="w-4 h-4 object-contain" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-xs">
              <div className="flex items-center gap-1">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
              </div>
              <span className="text-xs font-mono text-muted-foreground">Processing request...</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} className="h-px" />
      </div>
    </div>
  );
}

function SponsoredRecommendation({ messageId, query }: AdMeshContext) {
  const [shown, setShown] = useState(false);
  if (!isAdMeshProviderMounted()) return null;
  return (
    <AdMeshErrorBoundary>
      <div className={shown ? "mt-3 w-full border-t border-border/70 pt-3" : "w-full"}>
        <AdMeshRecommendations
          messageId={messageId}
          query={query}
          onRecommendationsShown={() => setShown(true)}
        />
      </div>
    </AdMeshErrorBoundary>
  );
}

class AdMeshErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function MessageItem(props: MessageActionProps) {
  const {
    message,
    adMesh,
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
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card border border-border shadow-xs mt-1">
          <img src="/nexuss-logo.png" alt="NEXUSS" className="w-4 h-4 object-contain" />
        </div>
      )}

      <div className="flex min-w-0 max-w-[85%] flex-col">
        {isEditing && !isAssistant ? (
          <div className="rounded-2xl rounded-tr-sm border border-border bg-card p-3 shadow-xs">
            <textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSaveEdit();
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
                onClick={onSaveEdit}
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
                : "rounded-2xl rounded-tr-sm border border-border bg-secondary px-4 py-3 text-xs leading-relaxed text-secondary-foreground shadow-xs"
            }
          >
            <MessageContent content={message.content} isAssistant={isAssistant} />
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
              onClick={onCopy}
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
                onClick={onRegenerate}
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
                onClick={onStartEdit}
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

        {isAssistant && adMesh && (
          <SponsoredRecommendation
            messageId={adMesh.messageId}
            query={adMesh.query}
          />
        )}
      </div>
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
            pre: PreBlock
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
  return <p className="whitespace-pre-wrap leading-relaxed">{content}</p>;
}

function StreamingContent({ content }: { content: string }) {
  return (
    <div className="prose dark:prose-invert prose-xs max-w-none font-sans">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content || "..."}
      </ReactMarkdown>
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
        className="absolute right-2.5 top-2.5 rounded bg-background border border-border px-2 py-1 text-[10px] font-mono text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 cursor-pointer shadow-xs"
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
