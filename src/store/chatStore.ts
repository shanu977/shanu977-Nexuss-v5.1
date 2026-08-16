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
import { chatService } from "@/services/chat";
import { ApiError } from "@/services/api";
import { settingsService } from "@/services/settings";
import { generateTitle, getErrorMessage } from "@/utils";
import db from "@/lib/db/db";
import { useUsageStore } from "@/store/usageStore";
import { useAuthStore } from "@/store/useAuthStore";
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

// Shared request path for sending a user turn and persisting the assistant
// reply. Used by the initial send AND by edit/regenerate so that every path
// preserves provider routing, model selection, fallback behavior, streaming
// state, usage tracking, and error handling identically.
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

  useChatStore.setState({
    loading: true,
    error: null,
    isStreaming: false,
    streamingMessage: "",
    fallbackNotice: null
  });

  try {
    const startTime = performance.now();
    const res = await chatService.send({ message: text, history, provider, model, image });
    const responseTime = performance.now() - startTime;

    // Record usage for EVERY attempted request (primary + fallbacks). The
    // successful attempt carries the actual provider/model that answered.
    const attempts = res.attempts ?? [];
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
    } else {
      // Older backend without an attempt log: fall back to a single record.
      await recordAttempts([
        {
          provider: (res.provider || provider) as ProviderType,
          model: res.model || model,
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          totalTokens: res.usage?.total_tokens ?? 0,
          responseTime: Math.round(responseTime),
          success: true
        }
      ]);
    }

    if (res.fallback_used) {
      useChatStore.setState({ fallbackNotice: res.fallback_used });
    }

    // Echo the exact provider/model the backend used so the on-screen
    // indicator can never drift from reality. Screen-share requests are
    // temporarily routed to a server-side vision model the user never picked;
    // keep the user's selection untouched there so the dropdown stays valid
    // for subsequent normal chat.
    const latest = useChatStore.getState();
    if (!image) {
      if (res.provider && res.provider !== latest.provider) {
        useChatStore.setState({ provider: res.provider as ProviderType });
      }
      if (res.model && res.model !== latest.model) {
        useChatStore.setState({ model: res.model });
      }
    }

    const asstMsg: Message = {
      id: newId(),
      chatId: chat.id,
      role: "assistant",
      content: res.reply,
      timestamp: Date.now()
    };
    await db.messages.add(asstMsg);
    await db.chats.update(chat.id, { updatedAt: asstMsg.timestamp });
    useChatStore.setState((s) => ({
      messages: [...s.messages, asstMsg],
      currentChat: s.currentChat
        ? { ...s.currentChat, updatedAt: asstMsg.timestamp }
        : s.currentChat,
      chats: s.chats.map((c) =>
        c.id === chat.id ? { ...c, updatedAt: asstMsg.timestamp } : c
      )
    }));
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
    useChatStore.setState({ loading: false, isStreaming: false, streamingMessage: "" });
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
  streamingMessage: "",
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
      streamingMessage: "",
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
      streamingMessage: wasCurrent ? "" : state.streamingMessage,
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

      // Persist the user's message locally and show it immediately. Chat
      // history lives in IndexedDB; the backend only receives the last 99
      // prior turns for context and never stores anything.
      await db.messages.add(userMsg);
      const updatedAt = Date.now();
      await db.chats.update(currentChat.id, { updatedAt });
      // Clear any previous fallback notice before the new request.
      set((state) => ({
        messages: [...state.messages, userMsg],
        loading: true,
        error: null,
        isStreaming: false,
        streamingMessage: "",
        fallbackNotice: null,
        currentChat: state.currentChat
          ? { ...state.currentChat, updatedAt }
          : state.currentChat,
        chats: state.chats.map((c) =>
          c.id === currentChat!.id ? { ...c, updatedAt } : c
        )
      }));

      const history = get()
        .messages.filter((m) => m.chatId === currentChat!.id && m.id !== userMsg.id)
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
      set({ error: getErrorMessage(e) });
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
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.messages.add(editedMsg);
        await db.chats.update(currentChat.id, { updatedAt: editedMsg.timestamp });
      });
    } catch (e: unknown) {
      set({ error: getErrorMessage(e) });
      return;
    }

    set((state) => ({
      messages: [...kept, editedMsg],
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessage: "",
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
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.chats.update(currentChat.id, { updatedAt });
      });
    } catch (e: unknown) {
      set({ error: getErrorMessage(e) });
      return;
    }

    set((state) => ({
      messages: kept,
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessage: "",
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
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-99);
    await requestAssistant(currentChat, userText, history, image);
  }
}));
