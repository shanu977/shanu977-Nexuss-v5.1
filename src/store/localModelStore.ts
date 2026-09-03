import { create } from "zustand";
import db from "@/lib/db/db";
import { useAuthStore } from "@/store/useAuthStore";
import { LocalProvider, LocalModel, LocalProviderType, normalizeEndpoint } from "@/types/localModels";
import { discoverOllamaModelsDetailed, DiscoveredOllamaModelDetailed } from "@/services/localModels";

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
  // Dynamic Ollama discovery (not persisted, per-user, per-session)
  discoveredOllamaModels: DiscoveredOllamaModelDetailed[];
  ollamaStatus: "connected" | "not_connected" | "error" | "loading" | "idle";
  ollamaError: string | null;
  ollamaLastRefresh: number | null;
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
  refreshOllamaModels: (endpoint?: string) => Promise<void>;
  clearDiscoveredOllamaModels: () => void;
  reset: () => void;
}

export const useLocalModelStore = create<LocalModelState>()((set, get) => ({
  providers: [],
  models: [],
  hydrated: false,
  discoveredOllamaModels: [],
  ollamaStatus: "idle",
  ollamaError: null,
  ollamaLastRefresh: null,

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

  refreshOllamaModels: async (endpoint) => {
    const uid = currentUid();
    if (!uid) {
      set({ discoveredOllamaModels: [], ollamaStatus: "error", ollamaError: "Not authenticated" });
      return;
    }
    set({ ollamaStatus: "loading", ollamaError: null });
    // Determine endpoint: provided, or existing Ollama provider, or default
    let targetEndpoint = endpoint;
    if (!targetEndpoint) {
      const existingOllama = get().providers.find((p) => p.providerType === "ollama" && p.enabled);
      targetEndpoint = existingOllama?.endpoint || "http://localhost:11434/v1";
    }
    try {
      const { models, endpointReachable } = await discoverOllamaModelsDetailed(targetEndpoint, "ollama");
      if (!endpointReachable) {
        set({
          discoveredOllamaModels: [],
          ollamaStatus: "not_connected",
          ollamaError: "Ollama is not connected. Start Ollama and try again. Ensure OLLAMA_ORIGINS allows this origin.",
          ollamaLastRefresh: Date.now(),
        });
        return;
      }
      if (models.length === 0) {
        set({
          discoveredOllamaModels: [],
          ollamaStatus: "connected",
          ollamaError: null,
          ollamaLastRefresh: Date.now(),
        });
        return;
      }
      // Ensure an Ollama provider exists for these models
      let ollamaProvider = get().providers.find((p) => p.providerType === "ollama");
      if (!ollamaProvider) {
        // Create a default Ollama provider for the discovered models
        const normalized = normalizeEndpoint(targetEndpoint, "ollama");
        const now = Date.now();
        ollamaProvider = {
          id: newId(),
          userId: uid,
          name: "Ollama",
          providerType: "ollama",
          endpoint: normalized,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        await db.localProviders.add(ollamaProvider);
        set((s) => ({ providers: [...s.providers, ollamaProvider!] }));
      }
      // Sync discovered models into persisted LocalModel table (create missing)
      const existingModelIds = new Set(get().models.filter((m) => m.providerId === ollamaProvider!.id).map((m) => m.modelId));
      const toCreate: LocalModel[] = [];
      for (const dm of models) {
        if (!existingModelIds.has(dm.modelId)) {
          toCreate.push({
            id: newId(),
            userId: uid,
            providerId: ollamaProvider!.id,
            modelId: dm.modelId,
            displayName: dm.modelId,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            size: dm.size,
            modifiedAt: dm.modified ? new Date(dm.modified).getTime() : dm.created ? dm.created * 1000 : undefined,
            family: dm.family,
            parameterSize: dm.parameterSize,
            quantization: dm.quantization,
          });
        } else {
          // Update metadata for existing
          const existing = get().models.find((m) => m.providerId === ollamaProvider!.id && m.modelId === dm.modelId);
          if (existing && (dm.size || dm.family)) {
            await db.localModels.update(existing.id, {
              size: dm.size ?? existing.size,
              family: dm.family ?? existing.family,
              parameterSize: dm.parameterSize ?? existing.parameterSize,
              quantization: dm.quantization ?? existing.quantization,
              updatedAt: Date.now(),
            } as Partial<LocalModel>);
          }
        }
      }
      if (toCreate.length > 0) {
        await db.localModels.bulkAdd(toCreate);
        set((s) => ({ models: [...s.models, ...toCreate] }));
      } else {
        // Refresh from DB to get updated metadata
        const refreshed = await db.localModels.where("userId").equals(uid).toArray();
        set({ models: refreshed });
      }
      set({
        discoveredOllamaModels: models,
        ollamaStatus: "connected",
        ollamaError: null,
        ollamaLastRefresh: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        discoveredOllamaModels: [],
        ollamaStatus: "error",
        ollamaError: msg,
        ollamaLastRefresh: Date.now(),
      });
    }
  },

  clearDiscoveredOllamaModels: () => set({ discoveredOllamaModels: [], ollamaStatus: "idle", ollamaError: null }),

  reset: () => set({ providers: [], models: [], hydrated: false, discoveredOllamaModels: [], ollamaStatus: "idle", ollamaError: null, ollamaLastRefresh: null }),
}));
