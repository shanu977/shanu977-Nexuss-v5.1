import { request } from "./api";

export interface CloudSettings {
  theme: string;
  language: string;
  provider: string;
  model: string;
  updatedAt: number;
}

export const settingsService = {
  get: () => request<CloudSettings>("/settings"),

  update: (body: { theme?: string; language?: string; provider?: string; model?: string }) =>
    request<CloudSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify(body)
    })
};
