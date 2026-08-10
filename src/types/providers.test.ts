import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_LIST,
  PROVIDERS,
  PROVIDER_MODEL_OPTIONS,
  getModelLabel,
  isValidModelForProvider,
  type ProviderType
} from "@/types/providers";

const BACKEND_ALLOWED_MODELS_PATH = join(
  process.cwd(),
  "backend",
  "app",
  "schemas",
  "settings.py"
);

function backendModelsByProvider(): Record<ProviderType, string[]> {
  const source = readFileSync(BACKEND_ALLOWED_MODELS_PATH, "utf8");
  const result = {} as Record<ProviderType, string[]>;
  for (const provider of PROVIDER_LIST) {
    const entry = source.match(
      new RegExp(`"${provider}"\\s*:\\s*\\{(.*?)\\}`, "s")
    );
    if (!entry) throw new Error(`Missing backend ALLOWED_MODELS entry for ${provider}`);
    const ids = [...entry[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    result[provider] = ids;
  }
  return result;
}

function frontendModelIds(provider: ProviderType): string[] {
  return PROVIDER_MODEL_OPTIONS[provider].map((m) => m.id);
}

describe("provider model catalog", () => {
  it("exposes a non-empty, unique model list for every provider", () => {
    for (const provider of PROVIDER_LIST) {
      const ids = frontendModelIds(provider);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const option of PROVIDER_MODEL_OPTIONS[provider]) {
        expect(option.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("never exposes the same model under two providers", () => {
    for (let i = 0; i < PROVIDER_LIST.length; i++) {
      for (let j = i + 1; j < PROVIDER_LIST.length; j++) {
        const a = frontendModelIds(PROVIDER_LIST[i]);
        const b = frontendModelIds(PROVIDER_LIST[j]);
        expect(a.filter((id) => b.includes(id))).toEqual([]);
      }
    }
  });

  it("keeps defaults valid and in the catalog for their provider", () => {
    for (const provider of PROVIDER_LIST) {
      expect(isValidModelForProvider(provider, DEFAULT_PROVIDER_MODELS[provider])).toBe(true);
      expect(isValidModelForProvider(provider, PROVIDERS[provider].model)).toBe(true);
    }
  });

  it("isValidModelForProvider accepts only the provider's own models", () => {
    for (const provider of PROVIDER_LIST) {
      for (const id of frontendModelIds(provider)) {
        expect(isValidModelForProvider(provider, id)).toBe(true);
      }
      for (const other of PROVIDER_LIST) {
        if (other === provider) continue;
        for (const id of frontendModelIds(other)) {
          expect(isValidModelForProvider(provider, id)).toBe(false);
        }
      }
    }
  });

  it("getModelLabel falls back to the raw id for unknown models", () => {
    expect(getModelLabel("groq", "llama-3.3-70b-versatile")).toContain("Llama");
    expect(getModelLabel("groq", "not-a-real-model")).toBe("not-a-real-model");
  });
});

describe("backend sync", () => {
  it("frontend model lists match backend ALLOWED_MODELS exactly", () => {
    const backend = backendModelsByProvider();
    for (const provider of PROVIDER_LIST) {
      expect(frontendModelIds(provider).sort()).toEqual(backend[provider].sort());
    }
  });

  it("frontend defaults match the backend DEFAULT_MODELS", () => {
    const source = readFileSync(BACKEND_ALLOWED_MODELS_PATH, "utf8");
    const serviceSource = readFileSync(
      join(process.cwd(), "backend", "app", "services", "settings_service.py"),
      "utf8"
    );
    const llmSource = readFileSync(
      join(process.cwd(), "backend", "app", "services", "llm_service.py"),
      "utf8"
    );
    void source;
    for (const provider of PROVIDER_LIST) {
      const expected = DEFAULT_PROVIDER_MODELS[provider];
      expect(serviceSource).toMatch(
        new RegExp(`"${provider}"\\s*:\\s*"${expected}"`)
      );
      expect(llmSource).toMatch(
        new RegExp(`"${provider}"\\s*:\\s*"${expected}"`)
      );
    }
  });
});
