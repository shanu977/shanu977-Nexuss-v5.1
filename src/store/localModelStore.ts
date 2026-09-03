import { create } from "zustand";
import db from "@/lib/db/db";
import { useAuthStore } from "@/store/useAuthStore";
import { LocalProvider, LocalModel, LocalProviderType, normalizeEndpoint } from "@/types/localModels";

function currentUid(): string | null {
  return useAuthStore.getState().user?.uid ?? null;
}
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface LocalModelState {
  providers: LocalProvider[];
  models: LocalModel[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addProvider: (input: { name: string; providerType: LocalProviderType; endpoint: string; apiKey?: string }) => Promise<LocalProvider>;
  updateProvider: (id: string, patch: Partial<Pick<LocalProvider, "name" | "endpoint" | "apiKey" | "enabled" | "providerType">>) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  addModel: (providerId: string, modelId: string, displayName?: string) => Promise<LocalModel>;
  removeModel: (id: string) => Promise<void>;
  toggleModel: (id: string, enabled: boolean) => Promise<void>;
  getModelsForProvider: (providerId: string) => LocalModel[];
  getEnabledModels: () => LocalModel[];
  getProviderForModel: (modelId: string) => LocalProvider | undefined;
  reset: () => void;
}

export const useLocalModelStore = create<LocalModelState>()((set, get) => ({
  providers: [],
  models: [],
  hydrated: false,

  hydrate: async () => {
    const uid = currentUid();
    if (!uid) {
      set({ providers: [], models: [], hydrated: true });
      return;
    }
    const providers = await db.localProviders.where("userId").equals(uid).toArray();
    const models = await db.localModels.where("userId").equals(uid).toArray();
    set({ providers, models, hydrated: true });
  },

  addProvider: async ({ name, providerType, endpoint, apiKey }) => {
    const uid = currentUid();
    if (!uid) throw new Error("Not authenticated");
    const normalized = normalizeEndpoint(endpoint, providerType);
    const now = Date.now();
    const provider: LocalProvider = {
      id: newId(),
      userId: uid,
      name: name.trim() || `${providerType} @ ${normalized}`,
      providerType,
      endpoint: normalized,
      apiKey: apiKey?.trim() || undefined,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.localProviders.add(provider);
    set((s) => ({ providers: [...s.providers, provider] }));
    return provider;
  },

  updateProvider: async (id, patch) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.localProviders.get(id);
    if (!existing || existing.userId !== uid) return;
    const updates: Partial<LocalProvider> = { ...patch, updatedAt: Date.now() };
    if (patch.endpoint) {
      const type = patch.providerType ?? existing.providerType;
      updates.endpoint = normalizeEndpoint(patch.endpoint, type);
    }
    if (patch.apiKey !== undefined) {
      updates.apiKey = patch.apiKey?.trim() || undefined;
    }
    await db.localProviders.update(id, updates as LocalProvider);
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...updates } as LocalProvider : p)),
    }));
  },

  removeProvider: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.localProviders.get(id);
    if (!existing || existing.userId !== uid) return;
    await db.transaction("rw", db.localProviders, db.localModels, async () => {
      await db.localProviders.delete(id);
      await db.localModels.where("providerId").equals(id).delete();
    });
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      models: s.models.filter((m) => m.providerId !== id),
    }));
  },

  addModel: async (providerId, modelId, displayName) => {
    const uid = currentUid();
    if (!uid) throw new Error("Not authenticated");
    const provider = await db.localProviders.get(providerId);
    if (!provider || provider.userId !== uid) throw new Error("Provider not found");
    const trimmed = modelId.trim();
    if (!trimmed) throw new Error("Model ID required");
    // Dedupe by providerId+modelId
    const existing = await db.localModels
      .where("[providerId+modelId]")
      .equals([providerId, trimmed])
      .first();
    if (existing) return existing;
    const now = Date.now();
    const model: LocalModel = {
      id: newId(),
      userId: uid,
      providerId,
      modelId: trimmed,
      displayName: displayName?.trim() || trimmed,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.localModels.add(model);
    set((s) => ({ models: [...s.models, model] }));
    return model;
  },

  removeModel: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.localModels.get(id);
    if (!existing || existing.userId !== uid) return;
    await db.localModels.delete(id);
    set((s) => ({ models: s.models.filter((m) => m.id !== id) }));
  },

  toggleModel: async (id, enabled) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.localModels.get(id);
    if (!existing || existing.userId !== uid) return;
    await db.localModels.update(id, { enabled, updatedAt: Date.now() });
    set((s) => ({ models: s.models.map((m) => (m.id === id ? { ...m, enabled } : m)) }));
  },

  getModelsForProvider: (providerId) => get().models.filter((m) => m.providerId === providerId),
  getEnabledModels: () => get().models.filter((m) => m.enabled),
  getProviderForModel: (modelId) => {
    const model = get().models.find((m) => m.modelId === modelId && m.enabled);
    if (!model) return undefined;
    return get().providers.find((p) => p.id === model.providerId);
  },

  reset: () => set({ providers: [], models: [], hydrated: false }),
}));
