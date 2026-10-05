"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "@/components/Modal";
import { CheckIcon } from "@/components/icons";
import {
  DELETION_STAGE_LABELS,
  DeletionStatus,
  getDeletionStatus,
  getReauthMethod,
  reauthenticateWithGoogle,
  reauthenticateWithPassword,
  startAccountDeletion
} from "@/services/account";
import { purgeLocalAccountData } from "@/services/accountData";
import { clearAuthCache } from "@/services/api";
import { useAuthStore } from "@/store/useAuthStore";
import { ESCAPE_GUARD_ATTR, getErrorMessage } from "@/utils";

const CONFIRMATION_TEXT = "DELETE";
const SUCCESS_REDIRECT_DELAY_MS = 1500;
const POLL_INTERVAL_MS = 1500;

const ACTIVE_STATES = ["queued", "running", "retry_wait"];

interface DeleteAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful deletion, just before the user is signed out. */
  onSuccess?: () => void;
}

/**
 * `checking`  — asking the backend whether a deletion is already underway
 * `confirm`   — type DELETE (and re-authenticate) to start it
 * `progress`  — backend job running; polled until it completes
 * `failed`    — bounded retries exhausted; the user may retry explicitly
 * `done`      — verified deletion, local purge + sign out follow
 */
type Phase = "checking" | "confirm" | "progress" | "failed" | "done";

function phaseForState(state: DeletionStatus["state"]): Phase {
  if (ACTIVE_STATES.includes(state)) return "progress";
  if (state === "failed") return "failed";
  if (state === "completed") return "done";
  return "confirm";
}

export default function DeleteAccountModal({
  isOpen,
  onClose,
  onSuccess
}: DeleteAccountModalProps) {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  const [phase, setPhase] = useState<Phase>("confirm");
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // True once this browser started (or resumed) the backend job: from then on
  // a status of "none" means the job finished and its row was removed.
  const startedRef = useRef(false);
  const uid = user?.uid ?? null;
  const reauthMethod = getReauthMethod(user);

  const finishDeletion = (message?: string | null) => {
    setPhase("done");
    if (message) setError(null);

    window.setTimeout(() => {
      const cleanup = async () => {
        try {
          if (uid) await purgeLocalAccountData(uid);
          clearAuthCache();
          onSuccess?.();
          await signOut();
        } catch (err) {
          // The account is already deleted server-side; a local cleanup hiccup
          // must never be reported as a failed deletion.
          console.error("Post-deletion cleanup failed:", err);
        }
      };
      void cleanup();
    }, SUCCESS_REDIRECT_DELAY_MS);
  };

  // On open: resume a deletion that is already underway instead of asking for
  // confirmation again, so a reload or a second tab never re-triggers work.
  useEffect(() => {
    if (!isOpen) {
      setPhase("confirm");
      setConfirmation("");
      setPassword("");
      setError(null);
      setStatus(null);
      setBusy(false);
      startedRef.current = false;
      return;
    }

    let cancelled = false;
    setPhase("checking");
    getDeletionStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        if (next.state !== "none") startedRef.current = true;
        setPhase(phaseForState(next.state));
      })
      .catch(() => {
        if (!cancelled) setPhase("confirm");
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Poll the backend while the job is in flight. The browser can be closed at
  // any point: the job keeps running server-side and this resumes it.
  useEffect(() => {
    if (!isOpen || phase !== "progress") return;
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await getDeletionStatus();
        if (cancelled) return;
        setStatus(next);
        if (next.state === "completed" || (next.state === "none" && startedRef.current)) {
          finishDeletion();
        } else if (next.state === "failed") {
          setPhase("failed");
        }
      } catch {
        // Transient polling errors are not user-facing failures: keep polling.
      }
    };

    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, phase, uid]);

  // Put the caret in the confirmation field as soon as the dialog opens.
  useEffect(() => {
    if (!isOpen || phase !== "confirm") return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, phase]);

  // Never let Escape/outside-click dismiss the dialog mid-deletion: the
  // post-deletion cleanup (local purge + sign out) must still run.
  const requestClose = () => {
    if (busy || phase === "checking" || phase === "progress" || phase === "done") return;
    onClose();
  };

  const canConfirm = confirmation === CONFIRMATION_TEXT;
  const canSubmit = canConfirm && (reauthMethod !== "password" || password.length > 0);

  const handleDelete = async () => {
    if (!canSubmit || busy || phase !== "confirm") return;
    setBusy(true);
    setError(null);

    // Real re-authentication first: the backend only accepts a token issued
    // in the last few minutes, and this proves the person at the keyboard
    // still owns the credential.
    try {
      if (reauthMethod === "password") {
        await reauthenticateWithPassword(password);
      } else {
        await reauthenticateWithGoogle();
      }
    } catch (err) {
      setBusy(false);
      setError(getErrorMessage(err));
      return;
    }

    let started: DeletionStatus;
    try {
      started = await startAccountDeletion();
    } catch (err) {
      setBusy(false);
      setError(getErrorMessage(err));
      return;
    }

    startedRef.current = true;
    setStatus(started);
    setBusy(false);

    if (started.state === "completed") {
      finishDeletion();
      return;
    }
    setPhase(phaseForState(started.state));
  };

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Resuming an already-authorized job: no new confirmation or password
      // prompt, just a fresh token and the backend's bounded retry.
      const next = await startAccountDeletion();
      setStatus(next);
      setBusy(false);
      if (next.state === "completed") {
        finishDeletion();
        return;
      }
      setPhase(phaseForState(next.state));
    } catch (err) {
      setBusy(false);
      setError(getErrorMessage(err));
    }
  };

  const stageLabel =
    status?.stage && status.stage in DELETION_STAGE_LABELS
      ? DELETION_STAGE_LABELS[status.stage]
      : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title="Delete your Nexuss account?"
    >
      <div {...{ [ESCAPE_GUARD_ATTR]: "" }} className="space-y-4 font-sans text-xs text-foreground">
        {phase === "checking" ? (
          <p role="status" className="py-3 text-center text-xs text-muted-foreground">
            Checking whether a deletion is already in progress…
          </p>
        ) : phase === "done" ? (
          <div role="status" className="flex flex-col items-center gap-2 py-3 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <CheckIcon className="h-5 w-5" />
            </span>
            <p className="text-xs font-semibold text-foreground">
              Your Nexuss account has been permanently deleted.
            </p>
            <p className="text-[11px] text-muted-foreground">
              You are being signed out and returned to the landing page.
            </p>
          </div>
        ) : phase === "progress" ? (
          <div role="status" className="space-y-3 py-2 text-center">
            <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <p className="text-xs font-semibold text-foreground">
              Your account is being permanently deleted.
            </p>
            <p className="text-[11px] text-foreground">{stageLabel ?? "Working…"}</p>
            {status?.detail && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">{status.detail}</p>
            )}
            {status && status.attempt > 1 && (
              <p className="text-[11px] text-muted-foreground">
                Attempt {status.attempt} — deletion continues on our servers even if you close
                this window.
              </p>
            )}
          </div>
        ) : phase === "failed" ? (
          <div className="space-y-4">
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
            >
              <span className="font-semibold">Deletion did not finish.</span>{" "}
              {status?.detail || "Automatic retries were exhausted."}
            </div>
            <p className="leading-relaxed text-muted-foreground">
              Your account is locked while the deletion is retried. You can try again now, or
              contact support if the problem persists.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={busy}
                className="rounded-xl border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={busy}
                className="rounded-xl bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-30 transition-colors cursor-pointer"
              >
                {busy ? "Retrying…" : "Retry deletion"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="leading-relaxed text-muted-foreground">
              Deleting your account permanently removes your Nexuss account and
              associated data. This action cannot be undone.
            </p>

            <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
              <li>Your profile, settings, and encrypted provider API keys on Nexuss servers.</li>
              <li>Your AI usage records and any feedback you submitted.</li>
              <li>Your chats, messages, and local model setup stored in this browser.</li>
              <li>Your Firebase sign-in account, so you cannot sign in again.</li>
            </ul>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
              >
                <span className="font-semibold">Your account was not deleted.</span> {error} You
                can try again.
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="delete-account-confirmation"
                className="block text-xs font-medium text-foreground"
              >
                Type {CONFIRMATION_TEXT} to confirm
              </label>
              <input
                id="delete-account-confirmation"
                ref={inputRef}
                type="text"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleDelete();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder={CONFIRMATION_TEXT}
                aria-describedby="delete-account-confirmation-hint"
                className="w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <p
                id="delete-account-confirmation-hint"
                className="text-[10px] text-muted-foreground"
              >
                The permanent deletion button stays disabled until you type{" "}
                {CONFIRMATION_TEXT} exactly.
              </p>
            </div>

            {reauthMethod === "password" && (
              <div className="space-y-1.5">
                <label
                  htmlFor="delete-account-password"
                  className="block text-xs font-medium text-foreground"
                >
                  Confirm your password
                </label>
                <input
                  id="delete-account-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleDelete();
                    }
                  }}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  aria-describedby="delete-account-password-hint"
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
                <p id="delete-account-password-hint" className="text-[10px] text-muted-foreground">
                  For your security we re-check your password before deleting anything.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={requestClose}
                disabled={busy}
                className="rounded-xl border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={!canSubmit || busy}
                className="rounded-xl bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-30 transition-colors cursor-pointer"
              >
                {busy
                  ? reauthMethod === "password"
                    ? "Verifying password…"
                    : "Confirming with Google…"
                  : "Delete Account Permanently"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
