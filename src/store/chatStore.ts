import { create } from "zustand";
import { ChatState, Chat, Message, ProviderType } from "@/types";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_LIST,
  isValidModelForProvider
} from "@/types/providers";
import {
  getLastChatId,
  setLastChatId,
  getLocalTheme,
  setLocalTheme,
  getLocalProvider,
  setLocalProvider,
  getLocalModel,
  setLocalModel,
  clearAccountStorage
} from "@/storage/localStorage";
import { chatService, ChatStreamErrorEvent, ChatStreamUsageEvent } from "@/services/chat";
import { ApiError } from "@/services/api";
import { settingsService } from "@/services/settings";
import { generateTitle, getErrorMessage } from "@/utils";
import { ReasoningFilter } from "@/utils/reasoning";
import db from "@/lib/db/db";
import { useUsageStore } from "@/store/usageStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useWorkspaceStore } from "@/workspace/store";
import {
  extractChangeBlock,
  stripChangeBlock,
  extractCommandBlock,
  stripCommandBlock,
  hasCommandFence
} from "@/workspace/agent/parse";
import Dexie from "dexie";

interface ChatStore extends ChatState {
  theme: string;
  reset: (clearStorage?: boolean) => void;
  sendMessageStream: (content: string, image?: string) => Promise<void>;
  createNewChat: () => Promise<Chat>;
  renameChat: (id: string, title: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  setProvider: (provider: ProviderType) => void;
  setModel: (model: string) => void;
  setTheme: (theme: string) => Promise<void>;
  clearError: () => void;
  hydrate: () => Promise<void>;
  searchChats: (query: string) => Promise<Chat[]>;
  editMessageAndRegenerate: (
    messageId: string,
    newContent: string,
    image?: string
  ) => Promise<void>;
  regenerateResponse: (messageId: string, image?: string) => Promise<void>;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function applyTheme(theme: string): void {
  if (typeof window === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// The authenticated Firebase UID is the single source of truth for ownership.
// It always comes from the auth store, never from the UI or localStorage.
function currentUid(): string | null {
  return useAuthStore.getState().user?.uid ?? null;
}

async function messagesForChat(uid: string, chatId: string): Promise<Message[]> {
  // Verify ownership before reading any message content.
  const chat = await db.chats.get(chatId);
  if (!chat || chat.userId !== uid) return [];
  return db.messages.where("chatId").equals(chatId).sortBy("timestamp");
}

// Persist the selection to Supabase so the backend /chat (which resolves
// provider/model from the user's settings) stays in lockstep with the UI.
// Non-fatal: chat requests carry explicit provider/model overrides, so a
// failed sync here never blocks sending a message.
function syncSettings(body: {
  provider?: string;
  model?: string;
  theme?: string;
}): void {
  settingsService.update(body).catch(() => {});
}

interface AttemptUsageEntry {
  provider: ProviderType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseTime: number;
  success: boolean;
}

// Record every provider attempt (primary + fallbacks) for usage tracking.
// Usage recording must never break the chat flow, so failures are swallowed.
async function recordAttempts(entries: AttemptUsageEntry[]): Promise<void> {
  try {
    for (const entry of entries) {
      await useUsageStore.getState().recordUsage(entry);
    }
  } catch {
    // ignore: usage tracking is best-effort
  }
}

interface ChatRequestHistory {
  role: string;
  content: string;
}

// Shown (and persisted) when a model reply is entirely internal reasoning with
// no recoverable answer. Storing an empty string would corrupt the next
// request's history (backend ChatTurn.content requires at least 1 char -> 422).
export const EMPTY_REPLY_FALLBACK =
  "I couldn't generate a complete response. Please try again or rephrase your question.";

// Shared request path for sending a user turn and streaming the assistant
// reply. Used by the initial send AND by edit/regenerate so that every path
// preserves provider routing, model selection, fallback behavior, streaming
// state, usage tracking, and error handling identically.
//
// Streaming: chunks are appended to a single assistant message in place as
// they arrive (visible immediately), the message is persisted to IndexedDB
// once the stream completes, and the reasoning filter is applied per chunk so
// markers never reach the screen even when split across chunk boundaries.
async function requestAssistant(
  chat: Chat,
  text: string,
  history: ChatRequestHistory[],
  image?: string
): Promise<void> {
  const state = useChatStore.getState();
  const provider = state.provider;
  const model = isValidModelForProvider(provider, state.model)
    ? state.model
    : DEFAULT_PROVIDER_MODELS[provider];
  const asstId = newId();

  useChatStore.setState({
    loading: true,
    error: null,
    isStreaming: true,
    streamingMessageId: asstId,
    fallbackNotice: null
  });

  // Create the streaming assistant message immediately (empty content) so the
  // UI can show the thinking indicator in place while waiting for the first
  // visible content chunk. It is updated in place as chunks arrive and only
  // persisted once with the final filtered text.
  useChatStore.setState((s) => ({
    messages: [
      ...s.messages,
      {
        id: asstId,
        chatId: chat.id,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now()
      }
    ]
  }));

  let usageEvent: ChatStreamUsageEvent | null = null;
  let errorEvent: ChatStreamErrorEvent | null = null;
  let display = "";

  try {
    const startTime = performance.now();
    // When the user has connected a Path workspace, the engine selects the most
    // relevant local files/sections for THIS question and attaches them as
    // optional context. The full project is never sent.
    const workspaceResult = useWorkspaceStore.getState().buildContextFor(text);
    const events = chatService.sendStream({
      message: text,
      history,
      provider,
      model,
      image,
      workspaceContext: workspaceResult?.contextText
    });
    const responseTime = performance.now() - startTime;

    // The model may attach fenced `workspace-change` / `workspace-command`
    // blocks proposing edits or runs. They are staged for approval and always
    // stripped from the transcript; nothing is ever executed or written
    // without the user approving it first (the validated tool layer enforces
    // the workspace boundary).
    const reasoner = new ReasoningFilter();

    // Incremental in-place update: only the streaming message object is
    // replaced (its content grows); every other message keeps its identity so
    // memoized MessageItems do not re-render on every token.
    const updateMessage = () => {
      useChatStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === asstId ? { ...m, content: display } : m
        )
      }));
    };

    for await (const event of events) {
      if (event.type === "chunk") {
        const visible = reasoner.push(event.content);
        if (!visible) continue;
        display += visible;
        updateMessage();
      } else if (event.type === "usage") {
        usageEvent = event;
        if (event.fallback_used) {
          useChatStore.setState({ fallbackNotice: event.fallback_used });
        }
      } else if (event.type === "error") {
        errorEvent = event;
      }
    }

    // Release any answer text the reasoning filter was holding back (e.g. a
    // marker split right before the stream ended) so nothing is lost.
    const tail = reasoner.flush();
    if (tail) {
      display += tail;
      updateMessage();
    }

    // Record usage for EVERY attempted request (primary + fallbacks). The
    // successful attempt carries the actual provider/model that answered.
    const attempts = usageEvent?.attempts ?? errorEvent?.attempts ?? [];
    if (attempts.length > 0) {
      await recordAttempts(
        attempts.map((a) => ({
          provider: a.provider as ProviderType,
          model: a.model,
          inputTokens: a.input_tokens ?? 0,
          outputTokens: a.output_tokens ?? 0,
          totalTokens: a.total_tokens ?? 0,
          responseTime: a.response_time_ms ?? 0,
          success: a.status === "success"
        }))
      );
    } else if (usageEvent) {
      // Older backend without an attempt log: fall back to a single record.
      await recordAttempts([
        {
          provider: (usageEvent.provider || provider) as ProviderType,
          model: usageEvent.model || model,
          inputTokens: usageEvent.usage?.input_tokens ?? 0,
          outputTokens: usageEvent.usage?.output_tokens ?? 0,
          totalTokens: usageEvent.usage?.total_tokens ?? 0,
          responseTime: Math.round(responseTime),
          success: true
        }
      ]);
    } else if (errorEvent) {
      await recordAttempts([
        {
          provider,
          model,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responseTime: 0,
          success: false
        }
      ]);
    }

    // A mid-stream failure keeps the partial text on screen but tells the user
    // the answer was interrupted (the regenerate button is the retry path).
    if (errorEvent) {
      useChatStore.setState({ error: errorEvent.message });
    }

    // Echo the exact provider/model the backend used so the on-screen
    // indicator can never drift from reality. Screen-share requests are
    // temporarily routed to a server-side vision model the user never picked;
    // keep the user's selection untouched there so the dropdown stays valid
    // for subsequent normal chat.
    if (usageEvent && !image) {
      const latest = useChatStore.getState();
      if (usageEvent.provider && usageEvent.provider !== latest.provider) {
        useChatStore.setState({ provider: usageEvent.provider as ProviderType });
      }
      if (usageEvent.model && usageEvent.model !== latest.model) {
        useChatStore.setState({ model: usageEvent.model });
      }
    }

    const filtered = display.trim();
    // Shown (and persisted) when a model reply is entirely internal reasoning
    // with no recoverable answer. Storing an empty string would corrupt the
    // next request's history (backend ChatTurn.content requires at least 1
    // char -> 422).
    const changeBlock = extractChangeBlock(filtered);
    let finalContent =
      filtered.length > 0 ? stripChangeBlock(filtered) : EMPTY_REPLY_FALLBACK;
    if (changeBlock) {
      void useWorkspaceStore
        .getState()
        .proposeChangeFromBlock(changeBlock.changes)
        .catch(() => {
          // Staging is best-effort; the reply is still shown either way.
        });
    }
    // The model may also attach a fenced `workspace-command` block proposing a
    // run/test. It is always stripped from the transcript (even when its
    // payload is invalid); a valid block is staged in the workspace panel for
    // approval. A command is only ever executed after the user runs it, and
    // only via the native runtime's validation layer.
    const commandBlock = extractCommandBlock(finalContent);
    if (commandBlock || hasCommandFence(finalContent)) {
      finalContent = stripCommandBlock(finalContent) || EMPTY_REPLY_FALLBACK;
      if (commandBlock) {
        void useWorkspaceStore
          .getState()
          .proposeCommandFromBlock(commandBlock)
          .catch(() => {
            // Staging is best-effort; the reply is still shown either way.
          });
      }
    }
    // Feed the last command result into the NEXT request so the model can
    // diagnose a failed run/test without needing a second prompt.
    if (useWorkspaceStore.getState().lastCommandResult) {
      const last = useWorkspaceStore.getState().lastCommandResult;
      if (last) {
        const resultText = [
          `## Last command result (previous turn)`,
          `Command: \`${last.command}\``,
          `Cwd: \`${last.cwd || "(workspace root)"}\``,
          `Exit: ${last.exitCode ?? "n/a"} (${last.timedOut ? "timed out" : last.killed ? "killed" : "completed"})`,
          `Duration: ${last.durationMs}ms`,
          ...(last.stdout ? [`\`\`\`\n${last.stdout}\n\`\`\``] : []),
          ...(last.stderr ? [`Stderr:\n\`\`\`\n${last.stderr}\n\`\`\``] : [])
        ].join("\n");
        useWorkspaceStore.getState().clearLastCommandResult();
        finalContent = `${finalContent}\n\n${resultText}`;
      }
    }

    const asstMsg: Message = {
      id: asstId,
      chatId: chat.id,
      role: "assistant",
      content: finalContent,
      timestamp: Date.now()
    };
    // Persist the completed assistant message (chunks were shown live but
    // only the final filtered text is stored).
    await db.messages.add(asstMsg);
    await db.chats.update(chat.id, { updatedAt: asstMsg.timestamp });
    useChatStore.setState((s) => {
      const exists = s.messages.some((m) => m.id === asstId);
      const mapped = s.messages.map((m) =>
        m.id === asstId
          ? { ...m, content: finalContent, timestamp: asstMsg.timestamp }
          : m
      );
      return {
        messages: exists ? mapped : [...mapped, asstMsg],
        currentChat: s.currentChat
          ? { ...s.currentChat, updatedAt: asstMsg.timestamp }
          : s.currentChat,
        chats: s.chats.map((c) =>
          c.id === chat.id ? { ...c, updatedAt: asstMsg.timestamp } : c
        )
      };
    });
  } catch (e: unknown) {
    // Record every failed attempt from the backend when the error body
    // carried the attempt log; otherwise record a single failed entry.
    const errorAttempts = e instanceof ApiError ? e.attempts : undefined;
    const current = useChatStore.getState();
    if (errorAttempts && errorAttempts.length > 0) {
      await recordAttempts(
        errorAttempts.map((a) => ({
          provider: a.provider as ProviderType,
          model: a.model,
          inputTokens: a.input_tokens ?? 0,
          outputTokens: a.output_tokens ?? 0,
          totalTokens: a.total_tokens ?? 0,
          responseTime: a.response_time_ms ?? 0,
          success: false
        }))
      );
    } else {
      await recordAttempts([
        {
          provider: current.provider,
          model: current.model,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responseTime: 0,
          success: false
        }
      ]);
    }
    useChatStore.setState({ error: getErrorMessage(e) });
  } finally {
    // If the stream produced no visible content at all (the request itself
    // threw before any chunk), drop the empty placeholder so no blank
    // assistant bubble lingers next to the error.
    const settled = useChatStore.getState();
    const asst = settled.messages.find((m) => m.id === asstId);
    if (asst && asst.content.trim() === "") {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== asstId)
      }));
    }
    useChatStore.setState({
      loading: false,
      isStreaming: false,
      streamingMessageId: null
    });
  }
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  currentChat: null,
  chats: [],
  messages: [],
  provider: "groq",
  model: DEFAULT_PROVIDER_MODELS.groq,
  loading: false,
  error: null,
  isStreaming: false,
  streamingMessageId: null,
  fallbackNotice: null,
  theme: "light",

  reset: (clearStorage = false) => {
    set({
      currentChat: null,
      chats: [],
      messages: [],
      provider: "groq",
      model: DEFAULT_PROVIDER_MODELS.groq,
      loading: false,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      theme: "light"
    });
    if (clearStorage) {
      applyTheme("light");
      clearAccountStorage();
    }
  },

  clearError: () => set({ error: null }),

  setProvider: (provider) => {
    if (!PROVIDER_LIST.includes(provider)) return;
    const model = DEFAULT_PROVIDER_MODELS[provider];
    set({ provider, model });
    setLocalProvider(provider);
    setLocalModel(model);
    syncSettings({ provider, model });
  },

  setModel: (model) => {
    // A model is only valid for the provider it belongs to. Reject anything
    // else instead of saving (and later sending) an invalid combination.
    const provider = get().provider;
    if (!isValidModelForProvider(provider, model)) return;
    set({ model });
    setLocalModel(model);
    syncSettings({ model });
  },

  setTheme: async (theme) => {
    set({ theme });
    applyTheme(theme);
    setLocalTheme(theme);
    syncSettings({ theme });
  },

  hydrate: async () => {
    try {
      const uid = currentUid();
      const theme = getLocalTheme();
      let chats: Chat[] = [];
      let currentChat: Chat | null = null;
      let messages: Message[] = [];

      // If no authenticated user exists, load ZERO account-owned chats.
      if (uid) {
        chats = await db.chats
          .where("[userId+updatedAt]")
          .between([uid, Dexie.minKey], [uid, Dexie.maxKey])
          .reverse()
          .toArray();
        const lastChat = getLastChatId(uid);
        const target = lastChat
          ? chats.find((c) => c.id === lastChat)
          : chats[0] || null;
        if (target) {
          currentChat = target;
          messages = await messagesForChat(uid, target.id);
        }
      }
      let provider = (getLocalProvider() as ProviderType) || "groq";
      if (!PROVIDER_LIST.includes(provider)) provider = "groq";
      let model = getLocalModel() || DEFAULT_PROVIDER_MODELS[provider];
      if (!isValidModelForProvider(provider, model)) {
        model = DEFAULT_PROVIDER_MODELS[provider];
      }
      set({
        chats,
        currentChat,
        messages,
        provider,
        model,
        fallbackNotice: null,
        theme
      });
      applyTheme(theme);
      setLocalTheme(theme);

      if (!uid) return;

      // Best-effort: reconcile UI selection with the user's saved Supabase
      // settings (source of truth for provider/model/theme). If the request
      // fails (offline, token issue) the local values stay.
      try {
        const remote = await settingsService.get();
        let remoteProvider = (remote.provider as ProviderType) || provider;
        if (!PROVIDER_LIST.includes(remoteProvider)) remoteProvider = provider;
        let remoteModel = remote.model || DEFAULT_PROVIDER_MODELS[remoteProvider];
        if (!isValidModelForProvider(remoteProvider, remoteModel)) {
          remoteModel = DEFAULT_PROVIDER_MODELS[remoteProvider];
        }
        set({
          provider: remoteProvider,
          model: remoteModel,
          theme: remote.theme || theme
        });
        applyTheme(remote.theme || theme);
        setLocalTheme(remote.theme || theme);
        setLocalProvider(remoteProvider);
        setLocalModel(remoteModel);
      } catch {
        // Local values already applied; nothing to surface.
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
    }
  },

  createNewChat: async () => {
    const uid = currentUid();
    if (!uid) throw new Error("Not authenticated");
    const chat: Chat = {
      id: newId(),
      userId: uid,
      title: "New chat",
      provider: get().provider,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.chats.add(chat);
    set((state) => ({
      chats: [chat, ...state.chats],
      currentChat: chat,
      messages: []
    }));
    setLastChatId(uid, chat.id);
    return chat;
  },

  loadChat: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const chat = get().chats.find((c) => c.id === id);
    if (!chat || chat.userId !== uid) return;
    const messages = await messagesForChat(uid, id);
    set({ currentChat: chat, messages });
    setLastChatId(uid, id);
  },

  renameChat: async (id, title) => {
    const uid = currentUid();
    const trimmed = title.trim();
    if (!trimmed || !uid) return;
    const existing = await db.chats.get(id);
    if (!existing || existing.userId !== uid) return;
    const updatedAt = Date.now();
    await db.chats.update(id, { title: trimmed, updatedAt });
    set((state) => ({
      chats: state.chats.map((c) => (c.id === id ? { ...c, title: trimmed, updatedAt } : c)),
      currentChat:
        state.currentChat?.id === id
          ? { ...state.currentChat, title: trimmed, updatedAt }
          : state.currentChat
    }));
  },

  deleteChat: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.chats.get(id);
    if (!existing || existing.userId !== uid) return;
    try {
      await db.transaction("rw", db.chats, db.messages, async () => {
        await db.chats.delete(id);
        await db.messages.where("chatId").equals(id).delete();
      });
    } catch (e) {
      set({ error: getErrorMessage(e) });
      return;
    }
    const wasCurrent = get().currentChat?.id === id;
    set((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
      currentChat: wasCurrent ? null : state.currentChat,
      messages: wasCurrent ? [] : state.messages,
      isStreaming: wasCurrent ? false : state.isStreaming,
      streamingMessageId: wasCurrent ? null : state.streamingMessageId,
      error: null
    }));
    if (getLastChatId(uid) === id) {
      setLastChatId(uid, wasCurrent ? null : get().currentChat?.id ?? null);
    }
  },

  searchChats: async (query) => {
    const uid = currentUid();
    const q = query.toLowerCase().trim();
    const chats = get().chats.filter((c) => c.userId === uid);
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  },

  sendMessageStream: async (content, image) => {
    const text = content.trim();
    if (!text) return;

    const current = get();
    if (current.loading || current.isStreaming) return;
    // Set the in-flight flag synchronously so a second send issued before the
    // first reaches its first await can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });

    // The entire flow is wrapped so any failure (local DB, network, provider)
    // surfaces as a user-visible error instead of failing silently.
    try {
      const uid = currentUid();
      let currentChat = get().currentChat;
      if (currentChat && currentChat.userId !== uid) {
        // Never allow a chat owned by another account to be reused or its
        // context sent to the backend.
        currentChat = null;
      }
      if (!currentChat) {
        currentChat = await get().createNewChat();
      }

      const userMsg: Message = {
        id: newId(),
        chatId: currentChat.id,
        role: "user",
        content: text,
        timestamp: Date.now()
      };

      // Show the user's message immediately; persistence runs right after so a
      // reload mid-request still keeps history intact. Chat history lives in
      // IndexedDB; the backend only receives the last 99 prior turns for
      // context and never stores anything.
      const updatedAt = Date.now();
      set((state) => ({
        messages: [...state.messages, userMsg],
        loading: true,
        error: null,
        isStreaming: false,
        streamingMessageId: null,
        fallbackNotice: null,
        currentChat: state.currentChat
          ? { ...state.currentChat, updatedAt }
          : state.currentChat,
        chats: state.chats.map((c) =>
          c.id === currentChat!.id ? { ...c, updatedAt } : c
        )
      }));
      await db.messages.add(userMsg);
      await db.chats.update(currentChat.id, { updatedAt });

      const history = get()
        .messages.filter(
          (m) =>
            m.chatId === currentChat!.id &&
            m.id !== userMsg.id &&
            m.content.trim().length > 0
        )
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-99);

      // No API key is sent to the backend. The backend resolves the key for
      // this provider from the user's Supabase-stored keys. Provider/model are
      // sent explicitly so the UI selection is always what the backend uses.
      // An optional `image` (a single fresh screen-share frame) is attached to
      // this request only; it is transient and never stored with the message.
      await requestAssistant(currentChat, text, history, image);

      const title = get().chats.find((c) => c.id === currentChat!.id)?.title;
      if (title === "New chat") {
        await get().renameChat(currentChat!.id, generateTitle(text));
      }
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
    }
  },

  // Replace an existing user message and everything generated after it, then
  // resubmit the edited text through the exact same request path as a normal
  // send (same provider/model routing, fallbacks, streaming, usage, errors).
  // While screen sharing is active, `image` carries the fresh frame captured
  // at send time so the edit is analyzed against the current screen too.
  editMessageAndRegenerate: async (messageId, newContent, image) => {
    const text = newContent.trim();
    if (!text) return;

    const uid = currentUid();
    if (!uid) return;
    const currentChat = get().currentChat;
    if (!currentChat || currentChat.userId !== uid) return;

    const current = get();
    if (current.loading || current.isStreaming) return;

    const messages = get().messages;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = messages[idx];
    if (target.role !== "user" || target.chatId !== currentChat.id) return;

    const editedMsg: Message = {
      id: newId(),
      chatId: currentChat.id,
      role: "user",
      content: text,
      timestamp: Date.now()
    };

    // Remove the edited message and every subsequent message (the old
    // assistant reply and anything after it) so history stays consistent.
    const removed = messages.slice(idx);
    const removedIds = removed.map((m) => m.id);
    const kept = messages.slice(0, idx);
    // Set the in-flight flag synchronously (before the first await) so a
    // racing regenerate/edit/send can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.messages.add(editedMsg);
        await db.chats.update(currentChat.id, { updatedAt: editedMsg.timestamp });
      });
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
      return;
    }

    set((state) => ({
      messages: [...kept, editedMsg],
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      currentChat: state.currentChat
        ? { ...state.currentChat, updatedAt: editedMsg.timestamp }
        : state.currentChat,
      chats: state.chats.map((c) =>
        c.id === currentChat.id
          ? { ...c, updatedAt: editedMsg.timestamp }
          : c
      )
    }));

    const history = kept
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-99);
    await requestAssistant(currentChat, text, history, image);
  },

  // Regenerate the assistant response for the preceding user turn. The
  // regenerated reply replaces the current assistant message and everything
  // generated after it, and reuses the existing request path so provider,
  // model, fallbacks, streaming, usage, and error handling are unchanged.
  // While screen sharing is active, `image` carries the fresh frame captured
  // at send time so the re-answer also sees the current screen.
  regenerateResponse: async (messageId, image) => {
    const uid = currentUid();
    if (!uid) return;
    const currentChat = get().currentChat;
    if (!currentChat || currentChat.userId !== uid) return;

    const current = get();
    if (current.loading || current.isStreaming) return;

    const messages = get().messages;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = messages[idx];
    if (target.role !== "assistant" || target.chatId !== currentChat.id) return;

    // The immediately preceding user message is the prompt being re-answered.
    const userIdx = idx - 1;
    if (userIdx < 0 || messages[userIdx].role !== "user") return;
    const userText = messages[userIdx].content;

    // Drop this assistant message and everything after it; keep prior turns.
    const removed = messages.slice(idx);
    const removedIds = removed.map((m) => m.id);
    const kept = messages.slice(0, idx);
    const updatedAt = Date.now();
    // Set the in-flight flag synchronously (before the first await) so a
    // racing regenerate/edit/send can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.chats.update(currentChat.id, { updatedAt });
      });
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
      return;
    }

    set((state) => ({
      messages: kept,
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      currentChat: state.currentChat
        ? { ...state.currentChat, updatedAt }
        : state.currentChat,
      chats: state.chats.map((c) =>
        c.id === currentChat.id ? { ...c, updatedAt } : c
      )
    }));

    // The user message being re-answered is sent as the request `message`;
    // history is everything before it.
    const history = kept
      .slice(0, userIdx)
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-99);
    await requestAssistant(currentChat, userText, history, image);
  }
}));
