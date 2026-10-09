"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  detectOllamaSetup,
  verifyLocalChat,
  friendlySetupError,
  unknownReasonCopy,
  type SetupDetection,
} from "@/services/ollamaSetup";
import {
  getDeviceProfile,
  recommendCatalogueModel,
  recommendInstalledModel,
  compatibleCatalogueModels,
  formatBytes,
  OLLAMA_MODEL_CATALOGUE,
  type DeviceProfile,
} from "@/services/modelCatalogue";
import { useLocalModelStore } from "@/store/localModelStore";
import { selectLocalModel } from "@/services/localModelSelection";
import { LOCAL_PROVIDER_DEFAULT_ENDPOINTS } from "@/types/localModels";
import type {
  DiscoveredOllamaModelDetailed,
  OllamaPullProgress,
} from "@/services/localModels";
import { AlertTriangleIcon, CheckIcon, DownloadIcon, XIcon } from "@/components/icons";

const ENDPOINT = LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama;
const INSTALL_URL = "https://ollama.com/download";

type SetupPhase = "detect" | "download" | "connecting" | "ready" | "failed";

export interface LocalSetupPanelProps {
  /** Close the panel (downloads keep running in the store). */
  onClose: () => void;
  /** Hand over to the manual/advanced provider configuration. */
  onAdvanced: () => void;
}

const SECONDARY_BUTTON_CLASSES =
  "rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const PRIMARY_BUTTON_CLASSES =
  "rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const DOWNLOAD_STEPS = [
  "Checking Ollama",
  "Preparing model download",
  "Downloading model data",
  "Verifying installation"
];

function downloadStepIndex(progress: OllamaPullProgress | null): number {
  if (!progress) return 1;
  if (progress.status === "success") return 3;
  if (progress.completed != null) return 2;
  if (/verifying|writing|digest/i.test(progress.status)) return 2;
  if (/manifest|waiting|starting/i.test(progress.status)) return 1;
  return 1;
}

/** Map raw Ollama pull statuses to plain user-facing text. */
function downloadStatusLabel(status: string | undefined): string {
  if (!status) return "Downloading model data…";
  if (/^success$/i.test(status)) return "Download complete";
  if (/verifying|digest/i.test(status)) return "Verifying download…";
  if (/writing manifest/i.test(status)) return "Finalizing…";
  if (/pulling manifest/i.test(status)) return "Preparing model download…";
  if (/waiting|starting/i.test(status)) return "Preparing model download…";
  return "Downloading model data…";
}

function installedModelLabel(modelId: string): string {
  return OLLAMA_MODEL_CATALOGUE.find((m) => m.id === modelId)?.label ?? modelId;
}

function installedMeta(m: DiscoveredOllamaModelDetailed): string {
  const parts = [
    m.parameterSize,
    m.quantization,
    m.family,
    m.size ? formatBytes(m.size) : undefined
  ].filter(Boolean);
  return parts.join(" • ");
}

function StepList({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="space-y-1" data-testid="setup-steps">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2 text-[11px]">
          {i < current ? (
            <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          ) : i === current ? (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground/50" aria-hidden="true" />
          )}
          <span className={i <= current ? "text-foreground" : "text-muted-foreground"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function LocalSetupPanel({ onClose, onAdvanced }: LocalSetupPanelProps) {
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  const [checking, setChecking] = useState(true);
  const [detection, setDetection] = useState<SetupDetection | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<SetupPhase>("detect");
  const [failure, setFailure] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const pullTask = useLocalModelStore((s) => s.ollamaPullTask);
  const pullProgress = useLocalModelStore((s) => s.ollamaPullProgress);
  const refreshOllamaModels = useLocalModelStore((s) => s.refreshOllamaModels);

  const continuedRef = useRef(false);

  const runDetection = useCallback(async () => {
    setChecking(true);
    setFailure(null);
    try {
      const d = await detectOllamaSetup({ endpoint: ENDPOINT });
      setDetection(d);
    } catch {
      setDetection({ state: "unknown", reason: "blocked", via: "direct" });
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * Persist the discovered model, select it, then verify with a real test
   * message. "Ready" is only reachable through this verification.
   */
  const connectFlow = useCallback(
    async (modelId: string) => {
      setPhase("connecting");
      setFailure(null);
      setSelected(modelId);
      try {
        await refreshOllamaModels(ENDPOINT);
        const st = useLocalModelStore.getState();
        if (st.ollamaStatus !== "connected") {
          throw new Error("Couldn't reach Ollama. Make sure it's running, then try again.");
        }
        // Verify with a real reply before touching the chat selection — a
        // failed setup must never look like a working model.
        const verification = await verifyLocalChat(ENDPOINT, modelId);
        if (!verification.ok) {
          throw new Error(verification.message || "The connection test failed.");
        }
        await selectLocalModel(modelId);
        useLocalModelStore.getState().clearPullTask();
        setPhase("ready");
      } catch (e) {
        setPhase("failed");
        setFailure(friendlySetupError(e));
      }
    },
    [refreshOllamaModels]
  );

  const startDownload = useCallback(async (modelId: string) => {
    setFailure(null);
    setPhase("download");
    try {
      await useLocalModelStore.getState().pullOllamaModel(modelId);
    } catch {
      // Failure and cancellation are surfaced through pullTask in the panel.
    }
  }, []);

  const backToDetection = useCallback(() => {
    useLocalModelStore.getState().clearPullTask();
    setPhase("detect");
    void runDetection();
  }, [runDetection]);

  useEffect(() => {
    let alive = true;
    void getDeviceProfile().then((d) => {
      if (alive) setDevice(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  // First open: resume an in-flight download, drop stale task states, or detect.
  useEffect(() => {
    const task = useLocalModelStore.getState().ollamaPullTask;
    if (task?.status === "pulling") {
      setPhase("download");
      setChecking(false);
      return;
    }
    if (task) useLocalModelStore.getState().clearPullTask();
    void runDetection();
  }, [runDetection]);

  // A finished download continues automatically: detect, then connect + verify.
  useEffect(() => {
    if (pullTask?.status !== "completed") return;
    if (phase !== "download" || continuedRef.current) return;
    continuedRef.current = true;
    const model = pullTask.model;
    void (async () => {
      const d = await detectOllamaSetup({ endpoint: ENDPOINT });
      setDetection(d);
      setChecking(false);
      if (d.state === "models") await connectFlow(model);
    })();
  }, [pullTask, phase, connectFlow]);

  const installedRec = useMemo(() => {
    if (detection?.state !== "models" || !detection.models) return null;
    const profile = device ?? { ramGB: null, freeDiskBytes: null, os: null };
    return recommendInstalledModel(detection.models, profile);
  }, [detection, device]);

  // Default selection follows the hardware-aware recommendation.
  useEffect(() => {
    if (device === null || selected) return;
    if (detection?.state !== "models" || !detection.models?.length) return;
    setSelected(installedRec?.modelId ?? detection.models[0].modelId);
  }, [device, detection, installedRec, selected]);

  const catalogueRec = useMemo(() => (device ? recommendCatalogueModel(device) : null), [device]);
  const otherModels = useMemo(() => {
    if (!device || !catalogueRec) return [];
    return compatibleCatalogueModels(device).filter((m) => m.id !== catalogueRec.model.id);
  }, [device, catalogueRec]);

  const phaseLabel = (() => {
    if (phase === "download") return "Installing model";
    if (phase === "connecting" || phase === "failed") return "Connecting";
    if (phase === "ready") return "Ready";
    if (checking || !detection) return "Checking device";
    if (detection.state === "models") return "Models available";
    return "Ollama detected";
  })();

  const downloadStep = pullTask ? downloadStepIndex(pullProgress) : 0;
  const hasBytes = pullProgress?.total != null && pullProgress?.completed != null;
  const percent =
    pullProgress?.percent != null && Number.isFinite(pullProgress.percent)
      ? Math.max(0, Math.min(100, pullProgress.percent))
      : null;
  const downloadError = pullTask?.error
    ? friendlySetupError(new Error(pullTask.error))
    : "The download failed. Please try again.";

  const showDetect = phase === "detect";

  return (
    <div
      className="space-y-3 rounded-xl border border-dashed border-border bg-muted/20 p-3"
      data-testid="local-setup-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold text-foreground">Set up local AI</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Nexuss will detect Ollama, install a model if you need one, and connect it to chat.
          </p>
          <p className="text-[10px] font-mono text-muted-foreground" data-testid="setup-endpoint">
            {ENDPOINT}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            data-testid="setup-phase"
          >
            {phaseLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close setup"
            className="rounded-lg p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ---------- Checking ---------- */}
      {showDetect && checking && (
        <div className="space-y-2" data-testid="setup-detecting">
          <p className="text-xs font-medium text-foreground">Checking your device…</p>
          <p className="text-[11px] text-muted-foreground">
            Looking for Ollama and any models you already have installed.
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
          </div>
        </div>
      )}

      {/* ---------- Models available ---------- */}
      {showDetect && !checking && detection?.state === "models" && (
        <div className="space-y-2.5" data-testid="setup-models">
          <div>
            <p className="text-xs font-semibold text-foreground">Ollama detected</p>
            <p className="text-[11px] text-muted-foreground">Models available on this device:</p>
          </div>
          <fieldset className="space-y-1.5" data-testid="setup-models-list">
            <legend className="sr-only">Choose a model</legend>
            {(detection.models ?? []).map((m) => {
              const recommended = installedRec?.modelId === m.modelId;
              return (
                <label
                  key={m.modelId}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                    selected === m.modelId
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="nexuss-setup-model"
                    value={m.modelId}
                    checked={selected === m.modelId}
                    onChange={() => setSelected(m.modelId)}
                    className="mt-0.5 cursor-pointer"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-foreground">{m.modelId}</span>
                      {recommended && (
                        <span
                          className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
                          data-testid="setup-recommended-badge"
                        >
                          Recommended
                        </span>
                      )}
                    </span>
                    {installedMeta(m) && (
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {installedMeta(m)}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {installedRec?.estimated && (
            <p className="text-[10px] text-muted-foreground" data-testid="setup-recommendation-note">
              The recommendation is an estimate — we couldn&apos;t read this device&apos;s exact specs.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!selected}
              onClick={() => selected && void connectFlow(selected)}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-connect"
            >
              Connect to Nexuss
            </button>
            <button
              type="button"
              onClick={onAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}

      {/* ---------- Ollama running, no models ---------- */}
      {showDetect && !checking && detection?.state === "no_models" && (
        <div className="space-y-2.5" data-testid="setup-no-models">
          <div>
            <p className="text-xs font-semibold text-foreground">No models installed yet</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Ollama is running but doesn&apos;t have any models. Download one below — Nexuss will
              install it and connect it automatically.
            </p>
          </div>

          {catalogueRec && (
            <div
              className="space-y-1.5 rounded-xl border border-primary/40 bg-primary/5 p-3"
              data-testid="setup-recommended"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">{catalogueRec.model.label}</p>
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                  Recommended
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {catalogueRec.model.params} • ~{formatBytes(catalogueRec.model.downloadBytes)}{" "}
                download • {catalogueRec.model.use}
              </p>
              <p className="text-[10px] text-muted-foreground">{catalogueRec.reason}</p>
              <button
                type="button"
                onClick={() => void startDownload(catalogueRec.model.id)}
                className={PRIMARY_BUTTON_CLASSES}
                data-testid="setup-download-start"
              >
                <DownloadIcon className="mr-1 inline h-3 w-3 align-[-2px]" />
                Download &amp; Set Up
              </button>
            </div>
          )}

          {otherModels.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                data-testid="setup-show-others"
              >
                {showAll ? "Hide other compatible models" : "See other compatible models"}
              </button>
              {showAll && (
                <ul className="space-y-1.5" data-testid="setup-other-models">
                  {otherModels.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2.5"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {m.label}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {m.params} • ~{formatBytes(m.downloadBytes)} • {m.use}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void startDownload(m.id)}
                        className={SECONDARY_BUTTON_CLASSES}
                        aria-label={`Download ${m.label}`}
                      >
                        Download
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={onAdvanced}
            className={SECONDARY_BUTTON_CLASSES}
            data-testid="setup-advanced"
          >
            Advanced configuration
          </button>
        </div>
      )}

      {/* ---------- Ollama not installed ---------- */}
      {showDetect && !checking && detection?.state === "not_installed" && (
        <div className="space-y-2.5" data-testid="setup-not-installed">
          <div>
            <p className="text-xs font-semibold text-foreground">Ollama isn&apos;t installed yet</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Install Ollama to run AI models locally on your device. Nexuss will help you finish
              the setup.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${PRIMARY_BUTTON_CLASSES} inline-block`}
              data-testid="setup-install-link"
            >
              Install Ollama
            </a>
            <button
              type="button"
              onClick={() => void runDetection()}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-check-again"
            >
              Check Again
            </button>
            <button
              type="button"
              onClick={onAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}

      {/* ---------- Ollama installed but stopped ---------- */}
      {showDetect && !checking && detection?.state === "stopped" && (
        <div className="space-y-2.5" data-testid="setup-stopped">
          <div>
            <p className="text-xs font-semibold text-foreground">Ollama is installed but not running</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Open the Ollama app on your computer, then check again.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runDetection()}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-check-again"
            >
              Check Again
            </button>
            <button
              type="button"
              onClick={onAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}

      {/* ---------- Could not determine (never "not installed") ---------- */}
      {showDetect && !checking && detection?.state === "unknown" && (
        <div className="space-y-2.5" data-testid="setup-unknown">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangleIcon className="h-4 w-4 shrink-0 text-destructive" />
              <p className="text-xs font-semibold text-foreground">
                {unknownReasonCopy(detection.reason)}
              </p>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              We couldn&apos;t tell whether Ollama is available on this computer. It may not be
              installed, not running, or your browser may be blocking local network access.
            </p>
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            <li>Install or open Ollama and make sure it is running.</li>
            <li>Start the Nexuss local connector on this computer.</li>
            <li>Allow local network access when your browser asks.</li>
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runDetection()}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-check-again"
            >
              Check Again
            </button>
            <a
              href={INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SECONDARY_BUTTON_CLASSES} inline-block`}
              data-testid="setup-install-link"
            >
              Install Ollama
            </a>
            <button
              type="button"
              onClick={onAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}

      {/* ---------- Downloading ---------- */}
      {phase === "download" && pullTask && (
        <div className="space-y-3" data-testid="setup-download">
          <div>
            <p className="text-xs font-semibold text-foreground">
              Installing {installedModelLabel(pullTask.model)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              You can close this panel — the download keeps running.
            </p>
          </div>

          {pullTask.status === "pulling" && (
            <>
              <StepList steps={DOWNLOAD_STEPS} current={downloadStep} />
              <div className="space-y-1.5" data-testid="setup-download-progress">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full bg-primary transition-all ${
                      percent == null ? "w-1/3 animate-pulse" : ""
                    }`}
                    style={percent != null ? { width: `${percent}%` } : undefined}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                  <span>{downloadStatusLabel(pullProgress?.status)}</span>
                  <span>{percent != null ? `${Math.round(percent)}%` : "…"}</span>
                </div>
                {hasBytes && (
                  <p className="text-[10px] font-mono text-muted-foreground" data-testid="setup-download-bytes">
                    {formatBytes(pullProgress!.completed!)} / {formatBytes(pullProgress!.total!)}
                    {typeof pullProgress?.bytesPerSecond === "number" && pullProgress.bytesPerSecond > 0
                      ? ` • ${formatBytes(pullProgress.bytesPerSecond)}/s`
                      : ""}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => useLocalModelStore.getState().cancelPullOllamaModel()}
                className={SECONDARY_BUTTON_CLASSES}
                data-testid="setup-cancel-download"
              >
                Cancel Download
              </button>
            </>
          )}

          {pullTask.status === "completed" && (
            <p className="text-[11px] text-muted-foreground" data-testid="setup-download-complete">
              Download complete — connecting to Nexuss…
            </p>
          )}

          {pullTask.status === "cancelled" && (
            <div className="space-y-2" data-testid="setup-download-cancelled">
              <p className="text-[11px] text-muted-foreground">Download cancelled.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startDownload(pullTask.model)}
                  className={PRIMARY_BUTTON_CLASSES}
                >
                  Try Again
                </button>
                <button type="button" onClick={backToDetection} className={SECONDARY_BUTTON_CLASSES}>
                  Back
                </button>
              </div>
            </div>
          )}

          {pullTask.status === "failed" && (
            <div className="space-y-2" data-testid="setup-download-failed">
              <p role="alert" className="text-[11px] leading-relaxed text-destructive">
                {downloadError}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startDownload(pullTask.model)}
                  className={PRIMARY_BUTTON_CLASSES}
                >
                  Try Again
                </button>
                <button type="button" onClick={backToDetection} className={SECONDARY_BUTTON_CLASSES}>
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------- Connecting / verifying ---------- */}
      {phase === "connecting" && (
        <div className="space-y-2.5" data-testid="setup-connecting">
          <div>
            <p className="text-xs font-semibold text-foreground">Connecting model to Nexuss</p>
            <p className="text-[11px] text-muted-foreground">
              Sending a tiny test message to confirm the model really replies before setup is
              marked complete.
            </p>
          </div>
          <ol className="space-y-1" data-testid="setup-connecting-steps">
            <li className="flex items-center gap-2 text-[11px]">
              <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span className="text-foreground">Connecting model to Nexuss</span>
            </li>
            <li className="flex items-center gap-2 text-[11px]">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              <span className="text-foreground">Testing chat</span>
            </li>
          </ol>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        </div>
      )}

      {/* ---------- Ready (only after a verified reply) ---------- */}
      {phase === "ready" && (
        <div className="space-y-2.5" data-testid="setup-ready">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
              <CheckIcon className="h-4 w-4 text-emerald-600" />
            </span>
            <p className="text-sm font-semibold text-foreground">Your local AI is ready</p>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {selected ? `${selected} is` : "The model is"} installed, connected, and verified with a
            test message. It&apos;s now selected for chat.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onClose}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-start-chatting"
            >
              Start Chatting
            </button>
            <button
              type="button"
              onClick={onClose}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-manage-models"
            >
              Manage Models
            </button>
          </div>
        </div>
      )}

      {/* ---------- Failed ---------- */}
      {phase === "failed" && (
        <div className="space-y-2.5" data-testid="setup-failure">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs font-semibold text-foreground">Setup didn&apos;t finish</p>
          </div>
          <p role="alert" className="text-[11px] leading-relaxed text-destructive">
            {failure}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setPhase("detect");
                setFailure(null);
                void runDetection();
              }}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-retry"
            >
              Try Again
            </button>
            <button
              type="button"
              onClick={onAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
