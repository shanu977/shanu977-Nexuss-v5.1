// Configurable catalogue of Ollama models Nexuss can set up automatically,
// plus the device-aware recommendation rules used by the local AI setup flow.
//
// Nothing here is hardcoded to a single model: the catalogue is a plain data
// list (easy to extend) and every recommendation is derived from the device
// information we could actually read. When hardware information is not
// available in the browser we never invent it — recommendations are returned
// with `estimated: true` so the UI can label them as estimates.

const GB = 1024 ** 3;

export type ModelTier = "lightweight" | "balanced" | "capable";

export interface CatalogueModel {
  /** Ollama model id used with the pull API. */
  id: string;
  label: string;
  tier: ModelTier;
  /** Parameter count as displayed, e.g. "3B". */
  params: string;
  /** Numeric parameter count for memory maths. */
  paramCount: number;
  /** Quantization used for the approximate download size. */
  quant: string;
  /** Approximate download size in bytes (registry metadata may differ slightly). */
  downloadBytes: number;
  /** Conservative minimum recommended RAM in bytes. */
  ramBytes: number;
  /** Intended workload. */
  use: string;
}

/**
 * Default recommendation catalogue. Approximate sizes are registry
 * approximations and are always shown to the user before a download starts.
 */
export const OLLAMA_MODEL_CATALOGUE: CatalogueModel[] = [
  {
    id: "qwen2.5:0.5b",
    label: "Qwen 2.5 0.5B",
    tier: "lightweight",
    params: "0.5B",
    paramCount: 0.5e9,
    quant: "Q4_K_M",
    downloadBytes: Math.round(0.4 * GB),
    ramBytes: 2 * GB,
    use: "Lightweight assistance on any device",
  },
  {
    id: "qwen2.5:3b",
    label: "Qwen 2.5 3B",
    tier: "balanced",
    params: "3B",
    paramCount: 3e9,
    quant: "Q4_K_M",
    downloadBytes: Math.round(1.9 * GB),
    ramBytes: 6 * GB,
    use: "General chat and everyday tasks",
  },
  {
    id: "qwen2.5-coder:3b",
    label: "Qwen 2.5 Coder 3B",
    tier: "balanced",
    params: "3B",
    paramCount: 3e9,
    quant: "Q4_K_M",
    downloadBytes: Math.round(1.9 * GB),
    ramBytes: 6 * GB,
    use: "Coding, refactors and code review",
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B",
    tier: "capable",
    params: "8B",
    paramCount: 8e9,
    quant: "Q4_K_M",
    downloadBytes: Math.round(4.9 * GB),
    ramBytes: 12 * GB,
    use: "Higher-quality reasoning and writing",
  },
];

export interface DeviceProfile {
  /** Physical RAM in GB when the browser exposes it, otherwise null. */
  ramGB: number | null;
  /** Approximate free disk space in bytes when it can be estimated. */
  freeDiskBytes: number | null;
  /** Coarse OS label derived from the user agent. */
  os: string | null;
}

/** Fraction of RAM a model may need to be recommended without caveats. */
const RAM_BUDGET_FACTOR = 0.75;
/** Fraction of free disk a download may occupy. */
const DISK_BUDGET_FACTOR = 0.9;

/**
 * Read whatever device information the browser actually exposes.
 * `navigator.deviceMemory` is coarse (and capped) and the storage estimate is
 * origin-scoped — both are used conservatively and reported as estimates.
 */
export async function getDeviceProfile(): Promise<DeviceProfile> {
  const nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator;
  let ramGB: number | null = null;
  const deviceMemory = nav ? (nav as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0) {
    ramGB = deviceMemory;
  }

  let freeDiskBytes: number | null = null;
  try {
    const estimate = await nav?.storage?.estimate?.();
    if (estimate && typeof estimate.quota === "number" && typeof estimate.usage === "number") {
      const free = estimate.quota - estimate.usage;
      if (free > 0) freeDiskBytes = free;
    }
  } catch {
    // Storage estimate unavailable — stay conservative with null.
  }

  const ua = nav?.userAgent ?? "";
  let os: string | null = null;
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return { ramGB, freeDiskBytes, os };
}

/** Parse Ollama parameter sizes like "7.6B", "13B", "0.5B" into a number. */
export function parseParamCount(raw?: string): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMB])?\s*$/i.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const factor = unit === "B" ? 1e9 : unit === "M" ? 1e6 : 1e3;
  return value * factor;
}

/**
 * Conservative in-memory footprint for a quantized (Q4-class) model:
 * roughly one byte per parameter plus a gigabyte of runtime overhead.
 */
export function estimateRamBytes(opts: {
  paramCount?: number | null;
  sizeBytes?: number | null;
}): number | null {
  if (opts.paramCount && opts.paramCount > 0) {
    return Math.round(opts.paramCount + 0.5 * GB);
  }
  if (opts.sizeBytes && opts.sizeBytes > 0) {
    // Q4 disk size ≈ memory size; add headroom for the runtime.
    return Math.round(opts.sizeBytes * 1.15 + 0.5 * GB);
  }
  return null;
}

function ramBudgetBytes(device: DeviceProfile): number | null {
  if (device.ramGB == null || device.ramGB <= 0) return null;
  return device.ramGB * GB * RAM_BUDGET_FACTOR;
}

/** Catalogue models that comfortably fit the device, best tiers included. */
export function compatibleCatalogueModels(device: DeviceProfile): CatalogueModel[] {
  const budget = ramBudgetBytes(device);
  const diskBudget =
    device.freeDiskBytes != null ? device.freeDiskBytes * DISK_BUDGET_FACTOR : null;
  const filtered = OLLAMA_MODEL_CATALOGUE.filter((m) => {
    if (budget != null && m.ramBytes > budget) return false;
    if (diskBudget != null && m.downloadBytes > diskBudget) return false;
    return true;
  });
  // Everything was filtered out (very small device): fall back to the
  // lightest options rather than showing an empty list.
  if (filtered.length === 0) {
    return [...OLLAMA_MODEL_CATALOGUE].sort((a, b) => a.ramBytes - b.ramBytes).slice(0, 2);
  }
  return filtered;
}

export interface Recommendation {
  model: CatalogueModel;
  /** True when hardware info was missing or tight — label it as an estimate. */
  estimated: boolean;
  reason: string;
}

const TIER_RANK: Record<ModelTier, number> = { lightweight: 0, balanced: 1, capable: 2 };

/**
 * Pick the most capable catalogue model that fits the device.
 * With unknown hardware the conservative default (small balanced model) is
 * chosen and flagged as an estimate.
 */
export function recommendCatalogueModel(device: DeviceProfile): Recommendation {
  const pool = compatibleCatalogueModels(device);

  if (device.ramGB == null) {
    const balanced = pool
      .filter((m) => m.tier === "balanced")
      .sort((a, b) => a.ramBytes - b.ramBytes);
    const model = balanced[0] ?? [...pool].sort((a, b) => a.ramBytes - b.ramBytes)[0];
    return {
      model,
      estimated: true,
      reason: "We couldn't read this device's exact specs — this is a conservative estimate.",
    };
  }

  if (device.ramGB > 0 && pool.every((m) => m.ramBytes > device.ramGB! * GB * RAM_BUDGET_FACTOR)) {
    // Should be rare thanks to the fallback in compatibleCatalogueModels.
    const lightest = [...pool].sort((a, b) => a.ramBytes - b.ramBytes)[0];
    return {
      model: lightest,
      estimated: true,
      reason: `Your device has about ${device.ramGB} GB of memory — this is the lightest option.`,
    };
  }

  const best = [...pool].sort((a, b) => {
    const tier = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (tier !== 0) return tier;
    return b.ramBytes - a.ramBytes;
  })[0];

  return {
    model: best,
    estimated: false,
    reason: `Fits your device's ~${device.ramGB} GB of memory.`,
  };
}

export interface InstalledModelMeta {
  modelId: string;
  size?: number;
  parameterSize?: string;
}

/**
 * Rough on-disk footprint of a provider install (installer + runtime). This is
 * a published-size approximation, never a measurement of the user's device —
 * the UI must always label it as an estimate.
 */
export const PROVIDER_INSTALL_ESTIMATE_BYTES = Math.round(1.5 * GB);

/** One row of the setup wizard's compact model chooser (at most three). */
export interface ModelOptionRecommendation {
  id: string;
  label: string;
  tier: ModelTier;
  /** Parameter count as displayed, when known. */
  params?: string;
  /** Approximate download size in bytes; 0 when the model is already installed. */
  downloadBytes: number;
  /** Conservative memory estimate in bytes, when known. */
  ramBytes: number | null;
  /** Intended workload / provenance line. */
  use: string;
  installed: boolean;
  compatible: boolean;
  /** Hardware information was incomplete — every number here is an estimate. */
  estimated: boolean;
  recommended: boolean;
}

/** Coarse tier for a model that is only known through its installed metadata. */
function tierForRam(ramBytes: number | null): ModelTier {
  if (ramBytes == null) return "balanced";
  if (ramBytes < 4 * GB) return "lightweight";
  if (ramBytes < 9 * GB) return "balanced";
  return "capable";
}

/**
 * Build the setup wizard's compact chooser: at most three recommendations —
 * one Lightweight / Balanced / Higher-capability pick from the maintained
 * catalogue, plus (when slots remain) models that are already installed on
 * this device so they are reused instead of downloaded again.
 *
 * Nothing is fabricated: options that clearly do not fit the measured device
 * are dropped, and when the device is too small for the whole catalogue only
 * the lightest options are returned, flagged `compatible: false`.
 */
export function recommendModelOptions(
  device: DeviceProfile,
  installed: InstalledModelMeta[] = []
): ModelOptionRecommendation[] {
  const installedIds = new Set(installed.map((m) => m.modelId));
  const budget = ramBudgetBytes(device);
  const diskBudget =
    device.freeDiskBytes != null ? device.freeDiskBytes * DISK_BUDGET_FACTOR : null;
  const estimated = device.ramGB == null;

  const fits = (m: { ramBytes: number; downloadBytes: number }, installedOk: boolean) => {
    if (budget != null && m.ramBytes > budget) return false;
    if (!installedOk && diskBudget != null && m.downloadBytes > diskBudget) return false;
    return true;
  };

  const chosen: CatalogueModel[] = [];
  const used = new Set<string>();
  for (const tier of ["lightweight", "balanced", "capable"] as ModelTier[]) {
    if (chosen.length >= 3) break;
    const candidates = OLLAMA_MODEL_CATALOGUE.filter(
      (m) => m.tier === tier && !used.has(m.id)
    );
    if (candidates.length === 0) continue;
    const alreadyInstalled = candidates.filter((m) => installedIds.has(m.id));
    const pool =
      alreadyInstalled.length > 0 ? alreadyInstalled : candidates.filter((m) => fits(m, false));
    const pick = [...pool].sort((a, b) => a.ramBytes - b.ramBytes)[0];
    if (!pick) continue;
    used.add(pick.id);
    chosen.push(pick);
  }

  // Free slots go to models that already live on this device: reusing one
  // costs no download and is always the cheapest option for the user.
  const extras: InstalledModelMeta[] = [];
  for (const m of installed) {
    if (chosen.length + extras.length >= 3) break;
    if (used.has(m.modelId)) continue;
    const need = estimateRamBytes({
      paramCount: parseParamCount(m.parameterSize),
      sizeBytes: m.size ?? null,
    });
    if (need != null && budget != null && need > budget) continue;
    extras.push(m);
  }
  extras.sort((a, b) => {
    const na = estimateRamBytes({ paramCount: parseParamCount(a.parameterSize), sizeBytes: a.size ?? null });
    const nb = estimateRamBytes({ paramCount: parseParamCount(b.parameterSize), sizeBytes: b.size ?? null });
    return (na ?? 0) - (nb ?? 0);
  });

  const rec = recommendCatalogueModel(device);
  const recommendedId =
    chosen.find((m) => m.id === rec.model.id)?.id ??
    chosen.find((m) => m.tier === "balanced")?.id ??
    chosen[0]?.id ??
    extras[0]?.modelId ??
    null;

  const options: ModelOptionRecommendation[] = chosen.map((m) => {
    const isInstalled = installedIds.has(m.id);
    return {
      id: m.id,
      label: m.label,
      tier: m.tier,
      params: m.params,
      downloadBytes: isInstalled ? 0 : m.downloadBytes,
      ramBytes: m.ramBytes,
      use: m.use,
      installed: isInstalled,
      compatible: fits(m, isInstalled),
      estimated,
      recommended: m.id === recommendedId,
    };
  });

  for (const m of extras) {
    const need = estimateRamBytes({
      paramCount: parseParamCount(m.parameterSize),
      sizeBytes: m.size ?? null,
    });
    options.push({
      id: m.modelId,
      label: m.modelId,
      tier: tierForRam(need),
      params: m.parameterSize,
      downloadBytes: 0,
      ramBytes: need,
      use: "Already on this device — nothing to download",
      installed: true,
      compatible: need == null || budget == null || need <= budget,
      estimated: estimated || need == null,
      recommended: m.modelId === recommendedId,
    });
  }

  if (options.length > 0) return options;

  // Nothing fits comfortably (very small device): offer the lightest options
  // rather than an empty screen, clearly flagged as a poor match.
  return [...OLLAMA_MODEL_CATALOGUE]
    .sort((a, b) => a.ramBytes - b.ramBytes)
    .slice(0, 2)
    .map((m, i) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      params: m.params,
      downloadBytes: m.downloadBytes,
      ramBytes: m.ramBytes,
      use: m.use,
      installed: false,
      compatible: false,
      estimated: true,
      recommended: i === 0,
    }));
}

/**
 * Recommend one of the *already installed* models using its real metadata
 * (parameter count or size) against the device profile. Never downloads
 * anything — if a suitable model exists, the user should just use it.
 */
export function recommendInstalledModel(
  models: InstalledModelMeta[],
  device: DeviceProfile
): { modelId: string; estimated: boolean } | null {
  if (models.length === 0) return null;

  const budget = ramBudgetBytes(device);
  const withNeed = models.map((m) => {
    const paramCount = parseParamCount(m.parameterSize);
    return { ...m, need: estimateRamBytes({ paramCount, sizeBytes: m.size ?? null }) };
  });

  if (budget == null) {
    // Unknown hardware: conservative pick is the lightest model.
    const sorted = [...withNeed].sort((a, b) => (a.need ?? Infinity) - (b.need ?? Infinity));
    return { modelId: sorted[0].modelId, estimated: true };
  }

  const fitting = withNeed
    .filter((m) => m.need != null && m.need <= budget)
    .sort((a, b) => (b.need ?? 0) - (a.need ?? 0));
  if (fitting.length > 0) {
    return { modelId: fitting[0].modelId, estimated: false };
  }

  // Nothing fits comfortably: offer the lightest and flag it.
  const sorted = [...withNeed].sort((a, b) => (a.need ?? Infinity) - (b.need ?? Infinity));
  return { modelId: sorted[0].modelId, estimated: true };
}

/** Human-readable byte size for setup cards and progress. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
