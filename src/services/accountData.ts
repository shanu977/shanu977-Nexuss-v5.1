import db from "@/lib/db/db";
import { STORAGE_KEYS } from "@/storage/localStorage";
import { clearAgentState } from "@/workspace/agent/agentState";
import { clearExecutionContext } from "@/workspace/agent/executionContext";

const AGENT_STATE_PREFIX = "nexuss_agent_state_";
const EXEC_CONTEXT_PREFIX = "nexuss_exec_context_";
const LEGACY_EXEC_CONTEXT_KEY = "nexuss_exec_context";

function safeGetItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function allLocalStorageKeys(): string[] {
  const keys: string[] = [];
  if (typeof window === "undefined") return keys;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch {
    // ignore
  }
  return keys;
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Drop legacy per-chat execution entries that belong to this account only. */
function filterLegacyExecContext(chatIdSet: Set<string>): void {
  const raw = safeGetItem(LEGACY_EXEC_CONTEXT_KEY);
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      removeKey(LEGACY_EXEC_CONTEXT_KEY);
      return;
    }
    const kept = parsed.filter(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        !("chatId" in entry) ||
        !chatIdSet.has(String((entry as { chatId?: unknown }).chatId))
    );
    if (kept.length === parsed.length) return;
    if (kept.length > 0) {
      window.localStorage.setItem(LEGACY_EXEC_CONTEXT_KEY, JSON.stringify(kept));
    } else {
      removeKey(LEGACY_EXEC_CONTEXT_KEY);
    }
  } catch {
    removeKey(LEGACY_EXEC_CONTEXT_KEY);
  }
}

/**
 * Remove every piece of Nexuss data this account owns from the current
 * browser: chats, messages, usage records, local model endpoints/models (from
 * IndexedDB) plus the account's `lastChatId` and per-chat agent state (from
 * localStorage).
 *
 * Deliberately scoped: another account signed in on the same browser keeps
 * its own rows, keys, and agent state. Device-level preferences (`theme`,
 * `provider`, `model`) are cleared by the existing sign-out flow.
 */
export async function purgeLocalAccountData(uid: string): Promise<void> {
  const chats = await db.chats.where("userId").equals(uid).toArray();
  const chatIds = chats.map((chat) => chat.id);
  const chatIdSet = new Set(chatIds);

  await db.transaction(
    "rw",
    db.chats,
    db.messages,
    db.usageRecords,
    db.localProviders,
    db.localModels,
    async () => {
      if (chatIds.length > 0) {
        await db.messages.where("chatId").anyOf(chatIds).delete();
      }
      await db.chats.where("userId").equals(uid).delete();
      await db.usageRecords.where("userId").equals(uid).delete();
      await db.localProviders.where("userId").equals(uid).delete();
      await db.localModels.where("userId").equals(uid).delete();
    }
  );

  // In-memory agent caches + their localStorage keys.
  for (const chatId of chatIds) {
    clearAgentState(chatId);
    clearExecutionContext(chatId);
    removeKey(`${AGENT_STATE_PREFIX}${chatId}`);
    removeKey(`${EXEC_CONTEXT_PREFIX}${chatId}`);
  }

  removeKey(`${STORAGE_KEYS.LAST_CHAT_ID}:${uid}`);
  for (const key of allLocalStorageKeys()) {
    if (key.startsWith(AGENT_STATE_PREFIX) && chatIdSet.has(key.slice(AGENT_STATE_PREFIX.length))) {
      removeKey(key);
    } else if (key.startsWith(EXEC_CONTEXT_PREFIX) && chatIdSet.has(key.slice(EXEC_CONTEXT_PREFIX.length))) {
      removeKey(key);
    }
  }
  filterLegacyExecContext(chatIdSet);
}

export interface LocalAccountExport {
  chats: unknown[];
  messages: unknown[];
  usageRecords: unknown[];
  localProviders: unknown[];
  localModels: unknown[];
  localPreferences: Record<string, string | null>;
  notes: string[];
}

/**
 * Collect this account's browser-stored data for "Export my data".
 * Local endpoint API keys are never included in the file.
 */
export async function gatherLocalAccountExport(uid: string): Promise<LocalAccountExport> {
  const chats = await db.chats.where("userId").equals(uid).toArray();
  const chatIds = chats.map((chat) => chat.id);
  const messages =
    chatIds.length > 0 ? await db.messages.where("chatId").anyOf(chatIds).toArray() : [];
  const usageRecords = await db.usageRecords.where("userId").equals(uid).toArray();
  const localProviders = await db.localProviders.where("userId").equals(uid).toArray();
  const localModels = await db.localModels.where("userId").equals(uid).toArray();

  return {
    chats,
    messages,
    usageRecords,
    localProviders: localProviders.map((provider) => ({
      id: provider.id,
      userId: provider.userId,
      name: provider.name,
      providerType: provider.providerType,
      endpoint: provider.endpoint,
      enabled: provider.enabled,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    })),
    localModels,
    localPreferences: {
      theme: safeGetItem(STORAGE_KEYS.THEME),
      provider: safeGetItem(STORAGE_KEYS.PROVIDER),
      model: safeGetItem(STORAGE_KEYS.MODEL),
      lastChatId: safeGetItem(`${STORAGE_KEYS.LAST_CHAT_ID}:${uid}`),
    },
    notes: [
      "Local model endpoint API keys are never exported.",
      "This section is data stored in this browser (IndexedDB / localStorage).",
    ],
  };
}
