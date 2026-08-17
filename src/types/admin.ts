/**
 * TypeScript types mirroring the backend Pydantic schemas in
 * `backend/app/schemas/admin.py`. Field names match the API responses exactly
 * (snake_case), including nullability, so the UI never has to guess.
 */

// ────────────────────────────────────────────── users

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "blocked";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
  provider: string;
  role: UserRole;
  status: UserStatus;
  created_at: number;
  updated_at: number;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface RoleUpdate {
  role: UserRole;
}

export interface DeleteResult {
  status: string;
  id: string;
}

// ────────────────────────────────────────────── analytics

export interface AnalyticsPeriod {
  from_ms: number | null;
  to_ms: number | null;
}

export interface AnalyticsTotals {
  total_users: number;
  active_users: number;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests_today: number;
}

export interface AnalyticsSummary {
  period: AnalyticsPeriod;
  totals: AnalyticsTotals;
}

export interface AiUsageDaily {
  date: string;
  requests: number;
  successful: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface AiUsageBucket {
  key: string;
  requests: number;
  successful: number;
  failed: number;
  total_tokens: number;
}

export interface AiUsageResponse {
  period: AnalyticsPeriod;
  filters: Record<string, unknown>;
  totals: AnalyticsTotals;
  series: AiUsageDaily[];
  by_provider: AiUsageBucket[];
  by_model: AiUsageBucket[];
  by_status: AiUsageBucket[];
  by_request_type: AiUsageBucket[];
}

// ────────────────────────────────────────────── feedback

export type FeedbackStatus = "new" | "reviewed" | "closed";

export interface FeedbackUser {
  id: string;
  email: string;
  name: string;
}

export interface AdminFeedback {
  id: string;
  user: FeedbackUser;
  rating: number | null;
  message: string;
  status: FeedbackStatus;
  created_at: number;
}

export interface AdminFeedbackList {
  items: AdminFeedback[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface FeedbackStatusUpdate {
  status: FeedbackStatus;
}

// ────────────────────────────────────────────── settings

export type SettingValueType = "string" | "boolean" | "number" | "json";

export interface AdminSetting {
  id: string;
  key: string;
  value: string;
  value_type: SettingValueType;
  description: string | null;
  updated_by_email: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminSettingsResponse {
  items: AdminSetting[];
}

export interface AdminSettingUpsert {
  key: string;
  value: string;
  value_type: SettingValueType;
  description?: string | null;
}

// ────────────────────────────────────────────── security / audit

export interface AuditLogEntry {
  id: string;
  admin_user_id: string | null;
  admin_email: string | null;
  admin_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: number;
}

export interface AuditLogList {
  items: AuditLogEntry[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

// ────────────────────────────────────────────── misc

export interface AdminHealthResponse {
  status: string;
  admin: { email: string; role: string };
  timestamp: number;
}
