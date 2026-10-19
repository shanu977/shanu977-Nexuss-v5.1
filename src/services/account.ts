import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  User as FirebaseUser
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { ApiError, request } from "@/services/api";
import { getErrorMessage } from "@/utils";

export interface AccountInfo {
  email: string;
  name: string;
  photo_url: string | null;
  provider: string;
  role: string;
  /** Account provisioning time (ms since epoch) from the server `users` row. */
  created_at: number;
}

/** Server-side export payload produced by `GET /account/export`. */
export interface ServerAccountExport {
  exportedAt: string;
  account: Record<string, unknown>;
  settings: Record<string, unknown> | null;
  apiKeys: { provider: string; createdAt: number; updatedAt: number }[];
  conversations: unknown[];
  usageRecords: unknown[];
  feedback: unknown[];
  notes: string[];
}

/**
 * State of the backend deletion job.
 *
 * * `none`       — nothing has been requested
 * * `queued`/`running`/`retry_wait` — deletion in flight (keep polling)
 * * `failed`     — the bounded retry budget was exhausted (manual retry)
 * * `completed`  — deletion finished and was verified
 */
export type DeletionState =
  | "none"
  | "queued"
  | "running"
  | "retry_wait"
  | "failed"
  | "completed";

export type DeletionStage = "queued" | "deleting_data" | "removing_auth" | "verifying";

/** Human-readable label for each backend deletion stage. */
export const DELETION_STAGE_LABELS: Record<DeletionStage, string> = {
  queued: "Deletion queued",
  deleting_data: "Removing your data from Nexuss servers",
  removing_auth: "Removing your Firebase sign-in account",
  verifying: "Verifying that nothing was left behind"
};

/** Progress reported by `GET /account/deletion` (never internal identifiers). */
export interface DeletionStatus {
  state: DeletionState;
  stage: DeletionStage | null;
  attempt: number;
  next_attempt_at: number | null;
  last_error: string | null;
  detail: string | null;
}

/** Profile facts for the signed-in account (never passwords or API keys). */
export function getAccountInfo(): Promise<AccountInfo> {
  return request<AccountInfo>("/account");
}

/** Everything the account owns on the server. API key ciphertexts excluded. */
export function fetchServerExport(): Promise<ServerAccountExport> {
  return request<ServerAccountExport>("/account/export");
}

/** Current deletion progress, or `state: "none"` when nothing is pending. */
export function getDeletionStatus(): Promise<DeletionStatus> {
  return request<DeletionStatus>("/account/deletion");
}

/**
 * Which re-authentication step this account must complete before deleting.
 *
 * Email/password accounts re-enter their password; every other provider
 * (Google) re-runs the OAuth popup. Both prove possession of the credential
 * immediately before the destructive call.
 */
export function getReauthMethod(user: FirebaseUser | null): "password" | "popup" {
  const providers = user?.providerData?.map((entry) => entry.providerId) ?? [];
  return providers.includes("password") ? "password" : "popup";
}

function reauthErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
    return "That password is not correct. Please try again.";
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return "The Google sign-in window was closed before it finished. Please try again.";
  }
  if (code === "auth/popup-blocked") {
    return "Your browser blocked the sign-in window. Allow popups for this site and retry.";
  }
  return getErrorMessage(err);
}

/** Re-enter the account password for a password-authenticated account. */
export async function reauthenticateWithPassword(password: string): Promise<void> {
  const user = auth.currentUser;
  if (!user?.email) {
    throw new ApiError(401, "You are signed out. Please sign in again to continue.");
  }
  try {
    await reauthenticateWithCredential(
      user,
      EmailAuthProvider.credential(user.email, password)
    );
  } catch (err) {
    throw new ApiError(400, reauthErrorMessage(err));
  }
}

/** Re-run the Google sign-in popup for a Google-authenticated account. */
export async function reauthenticateWithGoogle(): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError(401, "You are signed out. Please sign in again to continue.");
  }
  try {
    await reauthenticateWithPopup(user, googleProvider);
  } catch (err) {
    throw new ApiError(400, reauthErrorMessage(err));
  }
}

/**
 * Start (or resume) permanent deletion of the signed-in account.
 *
 * The ID token is force-refreshed immediately before the call — right after
 * the caller re-authenticated — so the backend can require *recent*
 * authentication for this destructive operation. The confirmation literal is
 * also validated server-side: the client never authorizes deletion on its
 * own, and every destructive step runs in the backend job that this call
 * starts.
 */
export async function startAccountDeletion(): Promise<DeletionStatus> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new ApiError(
      401,
      "You are signed out. Please sign in again to delete your account."
    );
  }

  let token: string;
  try {
    token = await currentUser.getIdToken(true);
  } catch {
    throw new ApiError(
      401,
      "Your session could not be refreshed. Please sign in again and retry."
    );
  }

  return request<DeletionStatus>("/account/delete", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
}

/** Trigger a browser download of `data` as pretty-printed JSON. */
export function downloadJson(filename: string, data: unknown): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
