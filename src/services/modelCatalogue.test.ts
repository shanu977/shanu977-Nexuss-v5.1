import { describe, expect, it } from "vitest";
import {
  OLLAMA_MODEL_CATALOGUE,
  parseParamCount,
  estimateRamBytes,
  compatibleCatalogueModels,
  recommendCatalogueModel,
  recommendInstalledModel,
  recommendModelOptions,
  formatBytes,
  type DeviceProfile,
} from "@/services/modelCatalogue";

const GB = 1024 ** 3;

function device(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return { ramGB: null, freeDiskBytes: null, os: null, ...overrides };
}

describe("modelCatalogue — configurable data", () => {
  it("ships a multi-tier catalogue instead of a single hardcoded model", () => {
    const tiers = new Set(OLLAMA_MODEL_CATALOGUE.map((m) => m.tier));
    expect(tiers.has("lightweight")).toBe(true);
    expect(tiers.has("balanced")).toBe(true);
    expect(tiers.has("capable")).toBe(true);
    for (const m of OLLAMA_MODEL_CATALOGUE) {
      expect(m.id).toMatch(/^[a-z0-9.-]+:[a-z0-9.]+$/i);
      expect(m.ramBytes).toBeGreaterThan(0);
      expect(m.downloadBytes).toBeGreaterThan(0);
    }
  });

  it("parses Ollama parameter sizes", () => {
    expect(parseParamCount("7.6B")).toBeCloseTo(7.6e9);
    expect(parseParamCount("0.5B")).toBeCloseTo(0.5e9);
    expect(parseParamCount("13B")).toBeCloseTo(13e9);
    expect(parseParamCount("nonsense")).toBeNull();
    expect(parseParamCount(undefined)).toBeNull();
  });

  it("estimates memory from parameter count or size, conservatively", () => {
    expect(estimateRamBytes({ paramCount: 3e9 })).toBeGreaterThanOrEqual(3e9);
    expect(estimateRamBytes({ sizeBytes: 2 * GB })).toBeGreaterThan(2 * GB);
    expect(estimateRamBytes({})).toBeNull();
  });

  it("formats bytes for setup cards", () => {
    expect(formatBytes(4.9 * GB)).toBe("4.9 GB");
    expect(formatBytes(50 * 1024 ** 2)).toBe("50 MB");
  });
});

describe("modelCatalogue — hardware-aware recommendations", () => {
  it("recommends a capable model on a high-memory device", () => {
    const rec = recommendCatalogueModel(device({ ramGB: 16 }));
    expect(rec.model.tier).toBe("capable");
    expect(rec.estimated).toBe(false);
  });

  it("recommends a balanced model on a typical laptop", () => {
    const rec = recommendCatalogueModel(device({ ramGB: 8 }));
    expect(rec.model.tier).toBe("balanced");
    expect(rec.estimated).toBe(false);
  });

  it("falls back to the lightest option on a tiny device", () => {
    const rec = recommendCatalogueModel(device({ ramGB: 2 }));
    expect(rec.model.ramBytes).toBeLessThanOrEqual(2 * GB);
    expect(rec.estimated).toBe(true);
  });

  it("labels unknown hardware as an estimate and stays conservative", () => {
    const rec = recommendCatalogueModel(device());
    expect(rec.estimated).toBe(true);
    expect(rec.model.tier).not.toBe("capable");
    expect(rec.reason).toMatch(/estimate/i);
  });

  it("filters models that don't fit the available disk", () => {
    const pool = compatibleCatalogueModels(device({ ramGB: 16, freeDiskBytes: 1 * GB }));
    expect(pool.every((m) => m.downloadBytes <= 1 * GB)).toBe(true);
  });
});

describe("modelCatalogue — installed model recommendations", () => {
  const models = [
    { modelId: "qwen2.5:0.5b", parameterSize: "0.5B", size: 400 * 1024 ** 2 },
    { modelId: "llama3.1:8b", parameterSize: "8.0B", size: 4.9 * GB },
    { modelId: "phi3:latest", parameterSize: "3.8B", size: 2.3 * GB },
  ];

  it("picks the most capable model that fits known memory", () => {
    const rec = recommendInstalledModel(models, device({ ramGB: 16 }));
    expect(rec?.modelId).toBe("llama3.1:8b");
    expect(rec?.estimated).toBe(false);
  });

  it("picks a smaller model when memory is limited", () => {
    const rec = recommendInstalledModel(models, device({ ramGB: 8 }));
    // 8B needs ~8.5GB, above the 6GB budget — 3.8B fits.
    expect(rec?.modelId).toBe("phi3:latest");
  });

  it("stays conservative and flagged as estimated without hardware info", () => {
    const rec = recommendInstalledModel(models, device());
    expect(rec?.modelId).toBe("qwen2.5:0.5b");
    expect(rec?.estimated).toBe(true);
  });

  it("returns null when nothing is installed", () => {
    expect(recommendInstalledModel([], device({ ramGB: 16 }))).toBeNull();
  });
});

describe("modelCatalogue — compact setup chooser", () => {
  it("returns at most three recommendations with exactly one marked recommended", () => {
    const options = recommendModelOptions(device({ ramGB: 16, freeDiskBytes: 100 * GB }));

    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(3);
    expect(options.filter((o) => o.recommended)).toHaveLength(1);
    const tiers = new Set(options.map((o) => o.tier));
    expect(tiers.size).toBe(options.length);
  });

  it("offers one option per tier when the device can handle the whole catalogue", () => {
    const options = recommendModelOptions(device({ ramGB: 16, freeDiskBytes: 100 * GB }));
    expect(options.map((o) => o.tier).sort()).toEqual(["balanced", "capable", "lightweight"]);
  });

  it("prefers models that are already installed so nothing is downloaded twice", () => {
    const installed = [{ modelId: "llama3.1:8b", parameterSize: "8.0B", size: 4.9 * GB }];
    const options = recommendModelOptions(device({ ramGB: 16, freeDiskBytes: 100 * GB }), installed);

    const llama = options.find((o) => o.id === "llama3.1:8b");
    expect(llama?.installed).toBe(true);
    expect(llama?.downloadBytes).toBe(0);
    // Installed picks are never asked to download themselves.
    for (const o of options) {
      if (o.installed) expect(o.downloadBytes).toBe(0);
    }
  });

  it("reuses installed models outside the catalogue in the free slots", () => {
    const installed = [{ modelId: "phi3:latest", parameterSize: "3.8B", size: 2.3 * GB }];
    const options = recommendModelOptions(device({ ramGB: 8, freeDiskBytes: 100 * GB }), installed);

    const phi = options.find((o) => o.id === "phi3:latest");
    expect(phi?.installed).toBe(true);
    expect(phi?.label).toBe("phi3:latest");
    expect(options.length).toBeLessThanOrEqual(3);
  });

  it("flags every number as an estimate when hardware is unknown", () => {
    const options = recommendModelOptions(device());
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.estimated).toBe(true);
  });

  it("offers the lightest options flagged incompatible on a device that fits nothing", () => {
    const options = recommendModelOptions(device({ ramGB: 1 }));

    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(3);
    expect(options.every((o) => !o.compatible)).toBe(true);
    expect([...options].sort((a, b) => a.downloadBytes - b.downloadBytes)).toEqual(options);
  });

  it("respects the measured disk budget for downloads it does not have to make", () => {
    const options = recommendModelOptions(device({ ramGB: 16, freeDiskBytes: 2 * GB }));
    expect(options.every((o) => o.installed || o.downloadBytes <= 2 * GB * 0.9)).toBe(true);
  });
});
