import { ProviderType } from "./providers";

export interface UsageRecord {
  id: string;
  userId: string;
  provider: ProviderType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseTime: number;
  timestamp: number;
  success: boolean;
}

export interface ProviderSummary {
  provider: ProviderType;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgResponseTime: number;
  models: Record<string, ModelSummary>;
}

export interface ModelSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgResponseTime: number;
}

export interface UsageSummary {
  providers: ProviderSummary[];
  totalRequests: number;
  totalTokens: number;
}
