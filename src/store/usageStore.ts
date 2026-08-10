import { create } from "zustand";
import { UsageRecord, UsageSummary, ProviderSummary } from "@/types/usage";
import { ProviderType } from "@/types";
import db from "@/lib/db/db";
import { useAuthStore } from "@/store/useAuthStore";
import Dexie from "dexie";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Ownership always comes from the authenticated Firebase user, never from
// anything the UI or localStorage could tamper with.
function currentUid(): string | null {
  return useAuthStore.getState().user?.uid ?? null;
}

interface UsageStore {
  summary: UsageSummary;
  loading: boolean;
  recordUsage: (entry: Omit<UsageRecord, "id" | "timestamp" | "userId">) => Promise<void>;
  loadSummary: () => Promise<void>;
  getRecords: (provider?: ProviderType) => Promise<UsageRecord[]>;
  clearUsage: () => Promise<void>;
  resetUsage: () => void;
  estimateContextTokens: (messages: { role: string; content: string }[]) => number;
}

function buildSummary(records: UsageRecord[]): UsageSummary {
  const providerMap = new Map<ProviderType, ProviderSummary>();

  for (const r of records) {
    let ps = providerMap.get(r.provider);
    if (!ps) {
      ps = {
        provider: r.provider,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgResponseTime: 0,
        models: {}
      };
      providerMap.set(r.provider, ps);
    }

    ps.requests++;
    ps.inputTokens += r.inputTokens;
    ps.outputTokens += r.outputTokens;
    ps.totalTokens += r.totalTokens;

    if (!ps.models[r.model]) {
      ps.models[r.model] = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgResponseTime: 0
      };
    }
    const ms = ps.models[r.model];
    ms.requests++;
    ms.inputTokens += r.inputTokens;
    ms.outputTokens += r.outputTokens;
    ms.totalTokens += r.totalTokens;
  }

  const providers = Array.from(providerMap.values());

  for (const ps of providers) {
    const providerRecords = records.filter((r) => r.provider === ps.provider);
    const totalTime = providerRecords.reduce((sum, r) => sum + r.responseTime, 0);
    ps.avgResponseTime = ps.requests > 0 ? totalTime / ps.requests : 0;

    for (const modelName of Object.keys(ps.models)) {
      const modelRecords = providerRecords.filter((r) => r.model === modelName);
      const modelTime = modelRecords.reduce((sum, r) => sum + r.responseTime, 0);
      ps.models[modelName].avgResponseTime =
        ps.models[modelName].requests > 0 ? modelTime / ps.models[modelName].requests : 0;
    }
  }

  const totalRequests = records.length;
  const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);

  return { providers, totalRequests, totalTokens };
}

export const useUsageStore = create<UsageStore>()((set) => ({
  summary: { providers: [], totalRequests: 0, totalTokens: 0 },
  loading: false,

  recordUsage: async (entry) => {
    const uid = currentUid();
    if (!uid) return;
    const record: UsageRecord = {
      ...entry,
      id: newId(),
      userId: uid,
      timestamp: Date.now()
    };
    await db.usageRecords.add(record);
  },

  loadSummary: async () => {
    set({ loading: true });
    try {
      const uid = currentUid();
      if (!uid) {
        set({ summary: { providers: [], totalRequests: 0, totalTokens: 0 } });
        return;
      }
      const records = await db.usageRecords
        .where("[userId+timestamp]")
        .between([uid, Dexie.minKey], [uid, Dexie.maxKey])
        .toArray();
      set({ summary: buildSummary(records) });
    } catch {
      set({ summary: { providers: [], totalRequests: 0, totalTokens: 0 } });
    } finally {
      set({ loading: false });
    }
  },

  getRecords: async (provider?: ProviderType) => {
    const uid = currentUid();
    if (!uid) return [];
    const records = await db.usageRecords
      .where("[userId+timestamp]")
      .between([uid, Dexie.minKey], [uid, Dexie.maxKey])
      .reverse()
      .toArray();
    if (provider) {
      return records.filter((r) => r.provider === provider);
    }
    return records;
  },

  clearUsage: async () => {
    const uid = currentUid();
    if (!uid) return;
    await db.usageRecords.where("userId").equals(uid).delete();
    set({ summary: { providers: [], totalRequests: 0, totalTokens: 0 } });
  },

  // In-memory only. Does not delete IndexedDB data so the same account keeps
  // its usage history across logout/login. Used by signOut().
  resetUsage: () => {
    set({ summary: { providers: [], totalRequests: 0, totalTokens: 0 }, loading: false });
  },

  estimateContextTokens: (messages) => {
    let totalChars = 0;
    for (const m of messages) {
      totalChars += m.content.length;
    }
    return Math.ceil(totalChars / 4);
  }
}));
