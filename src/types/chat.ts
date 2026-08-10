export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface FallbackAttempt {
  provider: string;
  model: string;
  attempt: number;
  status: "success" | "failed";
  http_status?: number | null;
  reason?: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  response_time_ms: number;
  timestamp: number;
}

export interface ChatResponse {
  reply: string;
  provider: string;
  model: string;
  usage?: UsageInfo;
  fallback_used?: string | null;
  attempts?: FallbackAttempt[];
}