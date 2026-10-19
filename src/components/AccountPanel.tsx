"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { useWorkspaceStore } from "@/workspace/store";
import {
  AccountInfo,
  DELETION_STAGE_LABELS,
  DeletionStatus,
  downloadJson,
  fetchServerExport,
  getAccountInfo,
  getDeletionStatus
} from "@/services/account";
import { gatherLocalAccountExport } from "@/services/accountData";
import { getErrorMessage } from "@/utils";
import { AlertTriangleIcon, DownloadIcon, TrashIcon } from "@/components/icons";
import DeleteAccountModal from "@/components/DeleteAccountModal";

function formatDate(value: number | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs text-foreground">{value}</span>
    </div>
  );
}

export default function AccountPanel() {
  const user = useAuthStore((s) => s.user);
  const workspace = useWorkspaceStore((s) => s.workspace);

  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);

  const email = info?.email || user?.email || "Unknown";
  const name = info?.name || user?.displayName || "";
  const avatarSource = (name || email).trim();
  const avatarChar = avatarSource[0]?.toUpperCase() || "U";
  const workspaceName = workspace?.name?.trim() || "No folder connected";

  // Ask the backend first: while a deletion is in flight the account is
  // locked, so profile rows (and the profile endpoint) may already be gone
  // and a 423 there must not be reported as a loading problem.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await getDeletionStatus();
        if (cancelled) return;
        if (next.state !== "none") {
          setDeletion(next);
          return;
        }
      } catch {
        // A status hiccup must not stop the profile from loading.
      }
      try {
        const account = await getAccountInfo();
        if (!cancelled) {
          setInfo(account);
          setInfoError(null);
        }
      } catch (err) {
        if (!cancelled) setInfoError(getErrorMessage(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the banner honest: refresh the job state while one exists.
  const deletionState = deletion?.state ?? null;
  useEffect(() => {
    if (!deletionState) return;
    const timer = window.setInterval(() => {
      getDeletionStatus()
        .then((next) => setDeletion(next.state === "none" ? null : next))
        .catch(() => {
          // Transient polling error: keep showing the last known state.
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [deletionState]);

  const handleExport = async () => {
    if (!user?.uid) {
      setExportMessage({ type: "error", text: "You must be signed in to export data." });
      return;
    }
    setExporting(true);
    setExportMessage(null);
    try {
      const [server, local] = await Promise.all([
        fetchServerExport(),
        gatherLocalAccountExport(user.uid)
      ]);
      downloadJson(`nexuss-export-${new Date().toISOString().slice(0, 10)}.json`, {
        exportedAt: new Date().toISOString(),
        server,
        local
      });
      setExportMessage({
        type: "success",
        text: "Your Nexuss data was downloaded as a JSON file."
      });
    } catch (err) {
      setExportMessage({ type: "error", text: getErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* PROFILE */}
      <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          Profile
        </h4>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-xs">
            {avatarChar}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-semibold text-foreground">
              {name?.trim() || "Nexuss user"}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">{email}</span>
          </div>
        </div>
        <div className="space-y-1 border-t border-border pt-2.5">
          <Row label="Workspace" value={workspaceName} />
        </div>
      </section>

      {/* ACCOUNT INFORMATION */}
      <section className="rounded-xl border border-border bg-card p-3.5 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          Account Information
        </h4>
        <div className="mt-1 divide-y divide-border">
          <Row label="Email" value={email} />
          <Row label="Member since" value={formatDate(info?.created_at)} />
          <Row label="Current workspace" value={workspaceName} />
        </div>
        {infoError && (
          <p className="mt-2 text-[11px] text-amber-600">
            Live account details could not be loaded: {infoError}
          </p>
        )}
      </section>

      {/* DATA & PRIVACY */}
      <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
          Data &amp; Privacy
        </h4>
        <div className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
          <p>Nexuss stores the following for your account:</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-medium text-foreground">Account details</span> — your email,
              display name, and sign-in provider from Firebase Authentication.
            </li>
            <li>
              <span className="font-medium text-foreground">Settings</span> — theme, language, and
              your selected provider and model, saved on Nexuss servers.
            </li>
            <li>
              <span className="font-medium text-foreground">Provider API keys</span> — stored
              encrypted on Nexuss servers. They are never shown here or included in an export.
            </li>
            <li>
              <span className="font-medium text-foreground">Usage records</span> — provider, model,
              token counts and response times for analytics. No chat content is recorded.
            </li>
            <li>
              <span className="font-medium text-foreground">This device only</span> — chat history,
              messages, usage history, and local model endpoints live in your browser&apos;s
              IndexedDB and are not synced to Nexuss servers.
            </li>
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || !!deletion}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            {exporting ? "Preparing…" : "Export my data"}
          </button>
          {exportMessage && (
            <span
              className={`text-[11px] ${
                exportMessage.type === "success" ? "text-emerald-500" : "text-destructive"
              }`}
              role="status"
            >
              {exportMessage.text}
            </span>
          )}
        </div>
      </section>

      {/* DANGER ZONE */}
      <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 space-y-3 shadow-xs">
        <h4 className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-destructive">
          <AlertTriangleIcon className="h-3.5 w-3.5" />
          Danger Zone
        </h4>
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">Delete your Nexuss account</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Deleting your account permanently removes your Nexuss account and associated data:
            your profile, settings, encrypted provider API keys, usage records, and this
            account&apos;s chats and messages stored in this browser. This action cannot be undone.
          </p>
        </div>
        {deletion ? (
          <div
            role="status"
            className={`space-y-1.5 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
              deletion.state === "failed"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            }`}
          >
            <p className="text-xs font-semibold">
              {deletion.state === "failed"
                ? "Account deletion did not finish."
                : "Your account is being permanently deleted."}
            </p>
            <p>
              {deletion.stage && deletion.stage in DELETION_STAGE_LABELS
                ? DELETION_STAGE_LABELS[deletion.stage]
                : deletion.detail}
            </p>
            <p className="text-[10px] opacity-80">
              {deletion.state === "failed"
                ? "Your account stays locked until the deletion finishes."
                : "It keeps running on our servers even if you close settings."}
            </p>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
            >
              {deletion.state === "failed" ? "Retry deletion" : "View deletion progress"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete Account
          </button>
        )}
      </section>

      <DeleteAccountModal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </div>
  );
}
