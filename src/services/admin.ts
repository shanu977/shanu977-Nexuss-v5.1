import { request } from "./api";
import type {
  AdminFeedback,
  AdminFeedbackList,
  AdminHealthResponse,
  AdminSetting,
  AdminSettingsResponse,
  AdminSettingUpsert,
  AdminUser,
  AdminUserList,
  AiUsageResponse,
  AnalyticsSummary,
  AuditLogList,
  DeleteResult,
  FeedbackStatus,
  UserRole,
} from "@/types/admin";

/**
 * Admin API client — the single frontend service layer for the real Phase 3
 * FastAPI endpoints. Reuses `request<T>()`, which attaches the Firebase ID
 * token as a Bearer header. There is no second authentication system here;
 * the backend enforces `get_current_admin` on every endpoint.
 */

function buildQuery(params: object): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
    )
    .join("&");
  return qs ? `?${qs}` : "";
}

export interface UserListParams {
  page?: number;
  page_size?: number;
  search?: string;
  role?: UserRole | "All";
  status?: "active" | "blocked" | "All";
  sort_by?: "created_at" | "email" | "name" | "role" | "status";
  sort_dir?: "asc" | "desc";
}

export interface FeedbackListParams {
  page?: number;
  page_size?: number;
  status?: FeedbackStatus | "All";
  rating?: number | "All";
  from_ms?: number;
  to_ms?: number;
  search?: string;
  sort_by?: "created_at" | "rating";
  sort_dir?: "asc" | "desc";
}

export interface AiUsageParams {
  from_ms?: number;
  to_ms?: number;
  provider?: string;
  model?: string;
}

export interface AuditListParams {
  page?: number;
  page_size?: number;
  search?: string;
  action?: string;
  target_type?: string;
  admin_user_id?: string;
  from_ms?: number;
  to_ms?: number;
  sort_dir?: "asc" | "desc";
}

export const adminApi = {
  /** UX-only guard: true only when the backend confirms an admin session. */
  isAdmin: async (): Promise<boolean> => {
    try {
      const res = await adminApi.health();
      return res.status === "ok";
    } catch {
      return false;
    }
  },

  health: () => request<AdminHealthResponse>("/admin/health"),

  // ── analytics
  getAnalyticsSummary: (params: { from_ms?: number; to_ms?: number } = {}) =>
    request<AnalyticsSummary>(`/admin/analytics/summary${buildQuery(params)}`),

  getAiUsage: (params: AiUsageParams = {}) =>
    request<AiUsageResponse>(`/admin/analytics/ai-usage${buildQuery(params)}`),

  // ── users
  getUsers: (params: UserListParams = {}) =>
    request<AdminUserList>(`/admin/users${buildQuery(params)}`),

  updateRole: (userId: string, role: UserRole) =>
    request<AdminUser>(`/admin/users/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  blockUser: (userId: string) =>
    request<AdminUser>(`/admin/users/${userId}/block`, { method: "POST" }),

  unblockUser: (userId: string) =>
    request<AdminUser>(`/admin/users/${userId}/unblock`, { method: "POST" }),

  deleteUser: (userId: string) =>
    request<DeleteResult>(`/admin/users/${userId}`, { method: "DELETE" }),

  // ── feedback
  getFeedback: (params: FeedbackListParams = {}) =>
    request<AdminFeedbackList>(`/admin/feedback${buildQuery(params)}`),

  updateFeedback: (feedbackId: string, status: FeedbackStatus) =>
    request<AdminFeedback>(`/admin/feedback/${feedbackId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  // ── settings
  getSettings: () => request<AdminSettingsResponse>("/admin/settings"),

  updateSettings: (items: AdminSettingUpsert[]) =>
    request<AdminSettingsResponse>("/admin/settings", {
      method: "PUT",
      body: JSON.stringify(items),
    }),

  // ── security
  getAudit: (params: AuditListParams = {}) =>
    request<AuditLogList>(`/admin/security/audit${buildQuery(params)}`),
};

export type { AdminSetting };
