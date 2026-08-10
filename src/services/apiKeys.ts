import { request } from "./api";

export interface ApiKeyStatus {
  provider: string;
  has_key: boolean;
  updatedAt: number;
}

export interface ApiKeyTestResult {
  valid: boolean;
  message: string;
}

export const apiKeyService = {
  // List per-provider presence. The raw keys are never sent back to the client.
  list: () => request<ApiKeyStatus[]>("/api-keys"),

  // Test an API key against the provider without saving it.
  test: (provider: string, api_key: string) =>
    request<ApiKeyTestResult>("/api-keys/test", {
      method: "POST",
      body: JSON.stringify({ provider, api_key })
    }),

  // Save or replace a provider's key. Validated first, then stored encrypted.
  save: (provider: string, api_key: string) =>
    request<ApiKeyStatus>("/api-keys", {
      method: "PUT",
      body: JSON.stringify({ provider, api_key })
    }),

  remove: (provider: string) =>
    request<void>(`/api-keys/${encodeURIComponent(provider)}`, {
      method: "DELETE"
    })
};
