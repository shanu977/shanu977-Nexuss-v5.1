"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  detectOllamaSetup,
  fetchConnectorDiskInfo,
  fetchConnectorOllamaStatus,
  verifyLocalChat,
  friendlySetupError,
  unknownReasonCopy,
  type SetupDetection,
  type ConnectorDiskInfo,
  type ConnectorOllamaStatus,
} from "@/services/ollamaSetup";
import {
  getDeviceProfile,
  recommendModelOptions,
  recommendInstalledModel,
  formatBytes,
  PROVIDER_INSTALL_ESTIMATE_BYTES,
  OLLAMA_MODEL_CATALOGUE,
  type DeviceProfile,
  type ModelOptionRecommendation,
  type ModelTier,
} from "@/services/modelCatalogue";
import { useLocalModelStore } from "@/store/localModelStore";
import { selectLocalModel } from "@/services/localModelSelection";
import { LOCAL_PROVIDER_DEFAULT_ENDPOINTS, isDesktop } from "@/types/localModels";
import type { DiscoveredOllamaModelDetailed } from "@/services/localModels";
import { AlertTriangleIcon, CheckIcon, XIcon } from "@/components/icons";

const ENDPOINT = LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama;
const INSTALL_URL = "https://ollama.com/download";

const EMPTY_DEVICE: DeviceProfile = { ramGB: null, freeDiskBytes: null, os: null };

/** Wizard steps. `failed` is rendered inside the panel, never as a separate screen. */
type Step = "intro" | "check" | "choose" | "confirm" | "install" | "ready" | "failed";

type InstallIssue = "need-install" | "need-start" | "unreachable";

type CheckStatus = "pending" | "ok" | "warn" | "fail";

interface CheckItem {
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface LocalSetupPanelProps {
  /**
   * Where the panel opens:
   * - "intro": no local provider found yet — show the "Set up local AI" card.
   * - "check": a provider was detected (or previously registered) — go
   *   straight to the device checks and the connect/recovery actions.
   */
  entry?: "intro" | "check";
  /** Close the panel (downloads keep running in the store). */
  onClose: () => void;
  /** Hand over to the manual/advanced provider configuration. */
  onAdvanced: () => void;
  /** The provider turned out to be connected already — focus its card. */
  onProviderReady?: () => void;
}

const SECONDARY_BUTTON_CLASSES =
  "rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const PRIMARY_BUTTON_CLASSES =
  "rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const TIER_LABEL: Record<ModelTier, string> = {
  lightweight: "Lightweight",
  balanced: "Balanced",
  capable: "Higher capability",
};

const PHASE_LABEL: Record<Step, string> = {
  intro: "Set up local AI",
  check: "Checking device",
  choose: "Choose a model",
  confirm: "Confirm",
  install: "Installing",
  ready: "Ready",
  failed: "Needs attention",
};

function downloadStatusLabel(status: string | undefined): string {
  if (!status) return "Downloading model data…";
  if (/^success$/i.test(status)) return "Download complete";
  if (/verifying|digest/i.test(status)) return "Verifying download…";
  if (/writing manifest/i.test(status)) return "Finalizing…";
  if (/pulling manifest/i.test(status)) return "Preparing model download…";
  if (/waiting|starting/i.test(status)) return "Preparing model download…";
  return "Downloading model data…";
}

function modelLabel(modelId: string): string {
  return OLLAMA_MODEL_CATALOGUE.find((m) => m.id === modelId)?.label ?? modelId;
}

/** True when the provider's API answered during the last detection. */
function providerReachable(d: SetupDetection | null): boolean {
  return d?.state === "models" || d?.state === "no_models";
}

/** Honest install/running facts, combining detection with the connector status. */
function providerFacts(
  detection: SetupDetection | null,
  status: ConnectorOllamaStatus | null
): { running: boolean; installed: boolean | null } {
  const running = detection ? providerReachable(detection) : (status?.running ?? false);
  let installed: boolean | null = null;
  if (detection) {
    if (detection.state === "not_installed") installed = false;
    else if (
      detection.state === "models" ||
      detection.state === "no_models" ||
      detection.state === "stopped"
    ) {
      installed = detection.installed ?? true;
    } else {
      installed = status?.installed ?? null;
    }
  } else {
    installed = status?.installed ?? null;
  }
  return { running, installed };
}

function installedBytesOf(models: DiscoveredOllamaModelDetailed[]): number {
  return models.reduce((sum, m) => sum + (typeof m.size === "number" ? m.size : 0), 0);
}

function StepList({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="space-y-1" data-testid="setup-install-steps">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2 text-[11px]">
          {i < current ? (
            <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          ) : i === current ? (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              aria-hidden="true"
            />
          ) : (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground/50"
              aria-hidden="true"
            />
          )}
          <span className={i <= current ? "text-foreground" : "text-muted-foreground"}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CheckRow({ item }: { item: CheckItem }) {
  return (
    <li className="flex items-start gap-2 text-[11px]" data-testid={`setup-check-${item.key}`}>
      {item.status === "pending" ? (
        <span
          className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"
          aria-hidden="true"
        />
      ) : item.status === "ok" ? (
        <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
      ) : item.status === "warn" ? (
        <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <XIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      )}
      <span className="min-w-0">
        <span className={item.status === "pending" ? "text-muted-foreground" : "text-foreground"}>
          {item.label}
        </span>
        {item.detail && (
          <span className="block text-[10px] leading-snug text-muted-foreground">
            {item.detail}
          </span>
        )}
      </span>
    </li>
  );
}

function InfoRow({ label, value, tag }: { label: string; value: string; tag?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">
        {value}
        {tag && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{tag}</span>}
      </span>
    </div>
  );
}

async function tryStartProvider(): Promise<boolean> {
  if (!isDesktop()) return false;
  const bridge = (
    window as unknown as {
      nexussDesktop?: {
        ollama?: {
          ensureRunning?: () => Promise<{ status?: string; running?: boolean }>;
        };
      };
    }
  ).nexussDesktop?.ollama;
  if (!bridge?.ensureRunning) return false;
  try {
    const state = await bridge.ensureRunning();
    return state?.running === true;
  } catch {
    return false;
  }
}

export default function LocalSetupPanel({
  entry = "intro",
  onClose,
  onAdvanced,
  onProviderReady,
}: LocalSetupPanelProps) {
  const [step, setStep] = useState<Step>(entry);
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  const [disk, setDisk] = useState<ConnectorDiskInfo | null>(null);
  const [detection, setDetection] = useState<SetupDetection | null>(null);
  const [providerStatus, setProviderStatus] = useState<ConnectorOllamaStatus | null>(null);
  const [checksDone, setChecksDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [installIssue, setInstallIssue] = useState<InstallIssue | null>(null);
  const [installLabels, setInstallLabels] = useState<string[]>([]);
  const [installIndex, setInstallIndex] = useState(0);
  const [connectingExisting, setConnectingExisting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const pullTask = useLocalModelStore((s) => s.ollamaPullTask);
  const pullProgress = useLocalModelStore((s) => s.ollamaPullProgress);
  const refreshOllamaModels = useLocalModelStore((s) => s.refreshOllamaModels);
  const discovered = useLocalModelStore((s) => s.discoveredOllamaModels);
  const registered = useLocalModelStore((s) =>
    s.providers.some((p) => p.providerType === "ollama" && p.enabled)
  );

  const continuedRef = useRef(false);
  const installPlanRef = useRef<{ model: string; connectIndex: number } | null>(null);

  const facts = providerFacts(detection, providerStatus);
  const installedModels = useMemo(
    () => detection?.models ?? (providerReachable(detection) ? discovered : []),
    [detection, discovered]
  );

  const runChecks = useCallback(async () => {
    setChecksDone(false);
    setConnectError(null);
    try {
      const dev = await getDeviceProfile();
      setDevice(dev);
    } catch {
      setDevice(null);
    }
    setDisk(await fetchConnectorDiskInfo());
    try {
      const d = await detectOllamaSetup({ endpoint: ENDPOINT });
      setDetection(d);
    } catch {
      setDetection({ state: "unknown", reason: "blocked", via: "direct" });
    }
    setProviderStatus(await fetchConnectorOllamaStatus());
    setChecksDone(true);
  }, []);

  // First open: resume an in-flight download, drop stale task states, or check.
  useEffect(() => {
    const task = useLocalModelStore.getState().ollamaPullTask;
    if (task?.status === "pulling") {
      setSelected(task.model);
      installPlanRef.current = {
        model: task.model,
        connectIndex: 2, // Downloading → Verifying model → Connecting → Finishing
      };
      setInstallLabels([
        "Downloading selected model",
        "Verifying model",
        "Connecting to Nexuss",
        "Finishing setup",
      ]);
      setInstallIndex(0);
      setStep("install");
      return;
    }
    if (task) useLocalModelStore.getState().clearPullTask();
    if (entry === "check") void runChecks();
  }, [entry, runChecks]);

  // The compact chooser: at most three device-appropriate recommendations.
  const options = useMemo<ModelOptionRecommendation[]>(
    () =>
      recommendModelOptions(
        device ?? EMPTY_DEVICE,
        installedModels.map((m) => ({
          modelId: m.modelId,
          size: m.size,
          parameterSize: m.parameterSize,
        }))
      ),
    [device, installedModels]
  );

  const selectedOption = options.find((o) => o.id === selected) ?? null;
  const recommendedOption = options.find((o) => o.recommended) ?? options[0] ?? null;

  // Exactly one model is selected when the chooser opens (the recommendation).
  useEffect(() => {
    if (step !== "choose") return;
    if (selected && options.some((o) => o.id === selected)) return;
    setSelected(recommendedOption?.id ?? null);
  }, [step, options, selected, recommendedOption]);

  const installedIds = useMemo(
    () => new Set(installedModels.map((m) => m.modelId)),
    [installedModels]
  );

  // ---- Storage maths (estimates are always labelled as such) ----
  const providerNeedsInstall = checksDone && facts.installed === false;
  const providerInstallBytes = providerNeedsInstall ? PROVIDER_INSTALL_ESTIMATE_BYTES : 0;
  const estimateOption = selectedOption ?? recommendedOption;
  const estimateNeedsDownload = estimateOption ? !estimateOption.installed : false;
  const estimateDownloadBytes = estimateNeedsDownload && estimateOption ? estimateOption.downloadBytes : 0;
  const totalAdditionalBytes = providerInstallBytes + estimateDownloadBytes;
  const freeBytes = disk?.freeBytes ?? null;
  const storageShortfall = freeBytes != null ? totalAdditionalBytes - freeBytes : null;
  const storageDefinitivelyInsufficient = storageShortfall != null && storageShortfall > 0;

  const checkItems = useMemo<CheckItem[]>(() => {
    const dev = device;
    const items: CheckItem[] = [];

    // 1. device compatibility
    if (dev === null) {
      items.push({
        key: "device",
        label: "Checking device compatibility",
        status: checksDone ? "warn" : "pending",
        detail: checksDone
          ? "Device details aren't available in this browser — recommendations stay conservative."
          : undefined,
      });
    } else {
      const parts = [
        dev.os,
        dev.ramGB != null ? `~${dev.ramGB} GB memory` : null,
      ].filter(Boolean) as string[];
      const known = dev.ramGB != null || dev.os != null;
      items.push({
        key: "device",
        label: "Checking device compatibility",
        status: known ? "ok" : "warn",
        detail: known
          ? parts.join(" • ")
          : "Device details aren't available — recommendations stay conservative.",
      });
    }

    // 2. available storage
    if (disk) {
      items.push({
        key: "storage",
        label: "Checking available storage",
        status: "ok",
        detail: `${formatBytes(disk.freeBytes)} free (measured)`,
      });
    } else if (dev?.freeDiskBytes != null) {
      items.push({
        key: "storage",
        label: "Checking available storage",
        status: "warn",
        detail: `${formatBytes(dev.freeDiskBytes)} available — a browser storage estimate, not your free disk`,
      });
    } else {
      items.push({
        key: "storage",
        label: "Checking available storage",
        status: checksDone ? "warn" : "pending",
        detail: checksDone
          ? "Storage information isn't available here — we won't assume it's zero."
          : undefined,
      });
    }

    // 3. supported providers
    if (!detection) {
      items.push({
        key: "provider",
        label: "Detecting supported local AI providers",
        status: checksDone ? "warn" : "pending",
        detail: checksDone ? "The provider check didn't complete." : undefined,
      });
    } else if (detection.state === "models" || detection.state === "no_models") {
      items.push({
        key: "provider",
        label: "Detecting supported local AI providers",
        status: "ok",
        detail: "Ollama found and responding",
      });
    } else if (detection.state === "stopped") {
      items.push({
        key: "provider",
        label: "Detecting supported local AI providers",
        status: "warn",
        detail: "Ollama is installed but not running",
      });
    } else if (detection.state === "not_installed") {
      items.push({
        key: "provider",
        label: "Detecting supported local AI providers",
        status: "warn",
        detail: "No supported local AI provider found yet",
      });
    } else {
      items.push({
        key: "provider",
        label: "Detecting supported local AI providers",
        status: "warn",
        detail: unknownReasonCopy(detection.reason),
      });
    }

    // 4. existing installed models
    if (!detection) {
      items.push({
        key: "models",
        label: "Checking existing installed models",
        status: checksDone ? "warn" : "pending",
        detail: checksDone ? "Couldn't list installed models." : undefined,
      });
    } else if (providerReachable(detection)) {
      const count = detection.models?.length ?? 0;
      items.push({
        key: "models",
        label: "Checking existing installed models",
        status: "ok",
        detail:
          count > 0
            ? `${count} ${count === 1 ? "model" : "models"} • ${formatBytes(installedBytesOf(detection.models ?? []))} (measured)`
            : "None yet — Nexuss can download one for you",
      });
    } else {
      items.push({
        key: "models",
        label: "Checking existing installed models",
        status: checksDone ? "warn" : "pending",
        detail: checksDone ? "Models can't be listed until the provider is reachable." : undefined,
      });
    }

    // 5. can the provider be installed or started?
    if (!detection && !providerStatus) {
      items.push({
        key: "installable",
        label: "Checking whether the provider can be installed or started",
        status: checksDone ? "warn" : "pending",
        detail: checksDone ? "Couldn't verify — try checking again." : undefined,
      });
    } else if (facts.running) {
      items.push({
        key: "installable",
        label: "Checking whether the provider can be installed or started",
        status: "ok",
        detail: "Installed and running",
      });
    } else if (facts.installed === false) {
      items.push({
        key: "installable",
        label: "Checking whether the provider can be installed or started",
        status: "warn",
        detail: "Not installed yet — setup walks you through the official installer",
      });
    } else if (facts.installed === true) {
      items.push({
        key: "installable",
        label: "Checking whether the provider can be installed or started",
        status: "warn",
        detail: "Installed but stopped — start it, then check again",
      });
    } else {
      items.push({
        key: "installable",
        label: "Checking whether the provider can be installed or started",
        status: "warn",
        detail: "Couldn't verify — check again once the provider is running",
      });
    }

    return items;
  }, [device, disk, detection, providerStatus, checksDone, facts]);

  const connectExisting = useCallback(async () => {
    setConnectingExisting(true);
    setConnectError(null);
    try {
      await refreshOllamaModels(ENDPOINT);
      const st = useLocalModelStore.getState();
      if (st.ollamaStatus !== "connected") {
        throw new Error("Couldn't reach Ollama. Start it, then try again.");
      }
      const models = st.discoveredOllamaModels;
      const pick = recommendInstalledModel(models, device ?? EMPTY_DEVICE);
      const modelId = pick?.modelId ?? models[0]?.modelId;
      if (!modelId) throw new Error("No models were found on this device.");
      const verification = await verifyLocalChat(ENDPOINT, modelId);
      if (!verification.ok) {
        throw new Error(verification.message || "The connection test failed.");
      }
      setSelected(modelId);
      await selectLocalModel(modelId);
      setStep("ready");
    } catch (e) {
      setConnectError(friendlySetupError(e));
    } finally {
      setConnectingExisting(false);
    }
  }, [refreshOllamaModels, device]);

  const connectPhase = useCallback(
    async (model: string) => {
      const connectIndex = installPlanRef.current?.connectIndex ?? 0;
      setInstallIndex(connectIndex);
      await refreshOllamaModels(ENDPOINT);
      const st = useLocalModelStore.getState();
      if (st.ollamaStatus !== "connected") {
        throw new Error("Couldn't reach Ollama. Make sure it's running, then try again.");
      }
      // Verify with a real reply before touching the chat selection — a failed
      // setup must never look like a working model.
      const verification = await verifyLocalChat(ENDPOINT, model);
      if (!verification.ok) {
        throw new Error(verification.message || "The connection test failed.");
      }
      setInstallIndex(connectIndex + 1);
      await selectLocalModel(model);
      useLocalModelStore.getState().clearPullTask();
      setStep("ready");
    },
    [refreshOllamaModels]
  );

  const failWith = useCallback((e: unknown) => {
    setStep("failed");
    setFailure(friendlySetupError(e));
  }, []);

  const startInstall = useCallback(async () => {
    const model = selected;
    if (!model) return;
    const option = options.find((o) => o.id === model);
    const needsDownload = !installedIds.has(model);

    setStep("install");
    setFailure(null);
    setInstallIssue(null);
    continuedRef.current = false;

    const labels = ["Preparing device"];
    let providerStepIndex = -1;
    if (!facts.running) {
      providerStepIndex = labels.length;
      labels.push(facts.installed === false ? "Installing provider" : "Starting provider");
    }
    labels.push("Verifying provider");
    const downloadIndex = needsDownload ? labels.length : -1;
    if (needsDownload) {
      labels.push(`Downloading ${modelLabel(model)}`);
      labels.push("Verifying model");
    }
    const connectIndex = labels.length;
    labels.push("Connecting to Nexuss");
    labels.push("Finishing setup");
    installPlanRef.current = { model, connectIndex };
    setInstallLabels(labels);
    setInstallIndex(0);

    try {
      // Recheck the conditions that matter right before a large download.
      const [freshDisk, freshDetection] = await Promise.all([
        fetchConnectorDiskInfo(),
        detectOllamaSetup({ endpoint: ENDPOINT }),
      ]);
      if (freshDisk) setDisk(freshDisk);
      if (freshDetection) setDetection(freshDetection);
      const freshFacts = providerFacts(freshDetection ?? detection, providerStatus);
      if (!freshDetection) throw new Error("We couldn't check your device. Please try again.");

      const required =
        (freshFacts.installed === false ? PROVIDER_INSTALL_ESTIMATE_BYTES : 0) +
        (needsDownload && option ? option.downloadBytes : 0);
      if (freshDisk && required > freshDisk.freeBytes) {
        throw new Error(
          `Not enough storage: ${formatBytes(freshDisk.freeBytes)} free, about ${formatBytes(
            required
          )} needed. Free up some space and try again.`
        );
      }

      // Install or start the provider only when it is actually required.
      setInstallIndex(providerStepIndex >= 0 ? providerStepIndex : labels.indexOf("Verifying provider"));
      if (!freshFacts.running) {
        if (freshFacts.installed === false) {
          setInstallIssue("need-install");
          return;
        }
        const started = await tryStartProvider();
        if (started) {
          const after = await detectOllamaSetup({ endpoint: ENDPOINT });
          setDetection(after);
          if (!providerReachable(after)) {
            setInstallIssue(after.state === "stopped" ? "need-start" : "unreachable");
            return;
          }
        } else {
          setInstallIssue(
            freshDetection.state === "stopped" ? "need-start" : "unreachable"
          );
          return;
        }
      }

      // The fresh detection above already verified the provider API.
      setInstallIndex(labels.indexOf("Verifying provider"));

      if (needsDownload) {
        setInstallIndex(downloadIndex);
        // The store owns the download so closing the panel never kills it; the
        // completion effect below continues the flow.
        void useLocalModelStore
          .getState()
          .pullOllamaModel(model)
          .catch(() => {
            /* surfaced through pullTask (failed/cancelled) */
          });
        return;
      }

      await connectPhase(model);
    } catch (e) {
      failWith(e);
    }
  }, [selected, options, installedIds, facts, providerStatus, detection, connectPhase, failWith]);

  // A finished download continues automatically: verify, then connect + verify.
  useEffect(() => {
    if (pullTask?.status !== "completed") return;
    if (step !== "install" || continuedRef.current) return;
    continuedRef.current = true;
    const model = pullTask.model;
    void (async () => {
      try {
        const d = await detectOllamaSetup({ endpoint: ENDPOINT });
        setDetection(d);
        if (d.state !== "models" || !d.models?.some((m) => m.modelId === model)) {
          throw new Error("The model didn't finish installing. Try again.");
        }
        await connectPhase(model);
      } catch (e) {
        failWith(e);
      }
    })();
  }, [pullTask, step, connectPhase, failWith]);

  // A failed download becomes a retryable failure; a cancelled one stays in
  // the install screen with explicit recovery actions.
  useEffect(() => {
    if (step !== "install" || !pullTask) return;
    if (pullTask.status === "failed") {
      failWith(new Error(pullTask.error || "The download failed. Please try again."));
    }
  }, [step, pullTask, failWith]);

  // The confirm step always needs a live selection — bounce back if it vanished.
  useEffect(() => {
    if (step === "confirm" && !selected) setStep("choose");
  }, [step, selected]);

  const hasModels = detection?.state === "models" && (detection.models?.length ?? 0) > 0;
  const caseConnected = checksDone && providerReachable(detection) && registered;
  const caseConnectExisting =
    checksDone && providerReachable(detection) && hasModels && !registered;

  const selectedInstalled = selected ? installedIds.has(selected) : false;
  const needsInstallNow = facts.installed === false;
  const needsStartNow = facts.installed === true && !facts.running;
  const needsDownloadNow = selected ? !selectedInstalled : false;
  const nothingToDo = !needsInstallNow && !needsStartNow && !needsDownloadNow && facts.running;

  const pullActive = pullTask?.status === "pulling";
  const percent =
    pullProgress?.percent != null && Number.isFinite(pullProgress.percent)
      ? Math.max(0, Math.min(100, pullProgress.percent))
      : null;
  const hasBytes = pullProgress?.total != null && pullProgress?.completed != null;

  const phaseLabel =
    step === "check" && !checksDone ? "Checking device" : PHASE_LABEL[step];

  const openAdvanced = () => onAdvanced();

  const startChecksAndContinue = () => {
    setStep("check");
    void runChecks();
  };

  return (
    <div
      className="space-y-3 rounded-xl border border-dashed border-border bg-muted/20 p-3"
      data-testid="local-setup-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold text-foreground">
            {step === "intro"
              ? "Set up local AI"
              : step === "check"
                ? "Check this device"
                : step === "choose"
                  ? "Choose one model"
                  : step === "confirm"
                    ? "Confirm your selection"
                    : step === "install"
                      ? "Setting up local AI"
                      : step === "ready"
                        ? "Local AI is ready"
                        : "Setup didn't finish"}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {step === "intro"
              ? "Run AI models directly on your device and use them in Nexuss."
              : step === "check"
                ? "Nexuss checks what this device can run before anything is downloaded."
                : step === "choose"
                  ? "Pick exactly one model — we only show the best fits for this device."
                  : step === "confirm"
                    ? "Nothing is installed or downloaded until you confirm."
                    : step === "install"
                      ? "Progress below is real — you can cancel while it's safe to do so."
                      : step === "ready"
                        ? "The provider is connected and verified with a test message."
                        : "You can retry or cancel — nothing was removed from your device."}
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

      {/* ---------------- Step: intro (no provider found) ---------------- */}
      {step === "intro" && (
        <div className="space-y-2.5" data-testid="setup-intro">
          <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            <li>Automatically check device compatibility.</li>
            <li>Check available disk space.</li>
            <li>Install the selected local provider when supported.</li>
            <li>Choose one model suitable for your device.</li>
            <li>Connect the installed model to Nexuss.</li>
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={startChecksAndContinue}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-start"
            >
              Set up local AI
            </button>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
              Cancel
            </button>
            <button
              type="button"
              onClick={openAdvanced}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Step 1: check this device ---------------- */}
      {step === "check" && (
        <div className="space-y-3" data-testid="setup-check">
          <ol className="space-y-1.5" data-testid="setup-checklist">
            {checkItems.map((item) => (
              <CheckRow key={item.key} item={item} />
            ))}
          </ol>

          {!checksDone && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" data-testid="setup-detecting">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
            </div>
          )}

          {/* Provider already connected to Nexuss — hand back to its card. */}
          {checksDone && caseConnected && (
            <div className="space-y-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="setup-already-connected">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
                  <CheckIcon className="h-4 w-4 text-emerald-600" />
                </span>
                <p className="text-xs font-semibold text-foreground">
                  Ollama is already connected to Nexuss
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {detection?.models?.length ?? discovered.length} models detected — pick the one
                you want to use on its provider card.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => (onProviderReady ? onProviderReady() : onClose())}
                  className={PRIMARY_BUTTON_CLASSES}
                  data-testid="setup-open-card"
                >
                  Open provider card
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Installed + reachable but not registered: one-click connect. */}
          {checksDone && caseConnectExisting && (
            <div className="space-y-2.5 rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="setup-connect-existing">
              <div>
                <p className="text-xs font-semibold text-foreground">
                  Ollama is running with{" "}
                  {detection?.models?.length ?? 0}{" "}
                  {(detection?.models?.length ?? 0) === 1 ? "model" : "models"} installed
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  It isn&apos;t registered with Nexuss yet. Connecting uses what&apos;s already on
                  this device — nothing is installed or downloaded again.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void connectExisting()}
                  disabled={connectingExisting}
                  className={PRIMARY_BUTTON_CLASSES}
                  data-testid="setup-connect"
                >
                  {connectingExisting ? "Connecting…" : "Connect to Nexuss"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  className={SECONDARY_BUTTON_CLASSES}
                  data-testid="setup-choose-instead"
                >
                  Choose a model instead
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* A connect failure stays visible even when registering the provider
              flips the card into its "already connected" layout. */}
          {checksDone && connectError && (
            <p
              role="alert"
              className="text-[11px] leading-relaxed text-destructive"
              data-testid="setup-connect-error"
            >
              {connectError}
            </p>
          )}

          {/* Everything else: honest notice + device facts + storage summary. */}
          {checksDone && !caseConnected && !caseConnectExisting && (
            <>
              {detection?.state === "stopped" && (
                <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-provider-notice">
                  <p className="text-xs font-semibold text-foreground">
                    Ollama is installed but not running
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Open the Ollama app on your computer, then check again. Nexuss won&apos;t ask
                    you to reinstall it.
                  </p>
                  <button
                    type="button"
                    onClick={() => void runChecks()}
                    className={SECONDARY_BUTTON_CLASSES}
                    data-testid="setup-check-again"
                  >
                    Check Again
                  </button>
                </div>
              )}

              {detection?.state === "not_installed" && (
                <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-provider-notice">
                  <p className="text-xs font-semibold text-foreground">
                    No local AI provider found
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Setup installs Ollama when your device supports it. You can also install it
                    yourself and come back.
                  </p>
                  <div className="flex flex-wrap gap-2">
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
                      onClick={() => void runChecks()}
                      className={SECONDARY_BUTTON_CLASSES}
                      data-testid="setup-check-again"
                    >
                      Check Again
                    </button>
                  </div>
                </div>
              )}

              {detection?.state === "unknown" && (
                <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-provider-notice">
                  <div className="flex items-center gap-2">
                    <AlertTriangleIcon className="h-4 w-4 shrink-0 text-destructive" />
                    <p className="text-xs font-semibold text-foreground">
                      {unknownReasonCopy(detection.reason)}
                    </p>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    We couldn&apos;t tell whether a local provider is available. It may not be
                    installed, may not be running, or your browser may be blocking local network
                    access.
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                    <li>Install or open Ollama and make sure it is running.</li>
                    <li>Start the Nexuss local connector on this computer.</li>
                    <li>Allow local network access when your browser asks.</li>
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void runChecks()}
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
                  </div>
                </div>
              )}

              <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-device-info">
                <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                  Your device
                </p>
                <div className="space-y-1">
                  <InfoRow
                    label="Available disk space"
                    value={
                      disk
                        ? formatBytes(disk.freeBytes)
                        : device?.freeDiskBytes != null
                          ? `~${formatBytes(device.freeDiskBytes)}`
                          : "Not available"
                    }
                    tag={
                      disk
                        ? "measured"
                        : device?.freeDiskBytes != null
                          ? "browser estimate"
                          : undefined
                    }
                  />
                  <InfoRow
                    label="Existing local models"
                    value={
                      providerReachable(detection) && (detection?.models?.length ?? 0) > 0
                        ? formatBytes(installedBytesOf(detection?.models ?? []))
                        : "None detected"
                    }
                    tag={providerReachable(detection) ? "measured" : undefined}
                  />
                  <InfoRow
                    label="Estimated storage needed by the provider"
                    value={
                      facts.installed === true
                        ? "Already installed"
                        : facts.installed === false
                          ? formatBytes(PROVIDER_INSTALL_ESTIMATE_BYTES)
                          : "Unknown"
                    }
                    tag={facts.installed === false ? "estimate" : undefined}
                  />
                  <InfoRow
                    label="Estimated additional download"
                    value={
                      estimateOption
                        ? estimateOption.installed
                          ? "None — already installed"
                          : formatBytes(estimateOption.downloadBytes)
                        : "Unknown"
                    }
                    tag={
                      estimateOption && !estimateOption.installed ? "estimate" : undefined
                    }
                  />
                  <InfoRow
                    label="Estimated additional space required"
                    value={totalAdditionalBytes > 0 ? formatBytes(totalAdditionalBytes) : "0 B"}
                    tag={totalAdditionalBytes > 0 ? "estimate" : undefined}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground" data-testid="setup-fit-note">
                  {device?.ramGB != null
                    ? `Memory: ~${device.ramGB} GB available to the browser (approximate).`
                    : "Memory couldn't be read — recommendations are conservative estimates."}
                </p>
              </div>

              <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-storage-summary">
                <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                  Storage summary
                </p>
                <div className="space-y-1">
                  <InfoRow
                    label="Available storage"
                    value={
                      disk
                        ? formatBytes(disk.freeBytes)
                        : device?.freeDiskBytes != null
                          ? `~${formatBytes(device.freeDiskBytes)}`
                          : "Unavailable"
                    }
                    tag={disk ? "measured" : device?.freeDiskBytes != null ? "estimate" : undefined}
                  />
                  <InfoRow
                    label="Provider installation"
                    value={
                      providerNeedsInstall ? formatBytes(PROVIDER_INSTALL_ESTIMATE_BYTES) : "Not required"
                    }
                    tag={providerNeedsInstall ? "estimate" : undefined}
                  />
                  <InfoRow
                    label="Model download"
                    value={
                      estimateOption
                        ? estimateOption.installed
                          ? "Not required"
                          : formatBytes(estimateOption.downloadBytes)
                        : "Not determined"
                    }
                    tag={
                      estimateOption && !estimateOption.installed ? "estimate" : undefined
                    }
                  />
                  <InfoRow
                    label="Total additional storage required"
                    value={totalAdditionalBytes > 0 ? formatBytes(totalAdditionalBytes) : "0 B"}
                    tag={totalAdditionalBytes > 0 ? "estimate" : undefined}
                  />
                </div>
                {storageDefinitivelyInsufficient && (
                  <p role="alert" className="text-[11px] leading-relaxed text-destructive" data-testid="setup-storage-blocked">
                    Not enough storage: about {formatBytes(totalAdditionalBytes)} is needed but only{" "}
                    {formatBytes(freeBytes as number)} is free. Free up space and check again.
                  </p>
                )}
                {freeBytes == null && (
                  <p className="text-[10px] text-muted-foreground" data-testid="setup-storage-unknown">
                    Free disk couldn&apos;t be measured here, so storage isn&apos;t treated as zero.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  disabled={!checksDone || storageDefinitivelyInsufficient}
                  className={PRIMARY_BUTTON_CLASSES}
                  data-testid="setup-continue"
                >
                  Continue
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={openAdvanced}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  data-testid="setup-advanced"
                >
                  Advanced configuration
                </button>
              </div>
            </>
          )}

          {checksDone && (caseConnected || caseConnectExisting) && (
            <button
              type="button"
              onClick={openAdvanced}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
          )}
        </div>
      )}

      {/* ---------------- Step 2: choose exactly one model ---------------- */}
      {step === "choose" && (
        <div className="space-y-2.5" data-testid="setup-choose">
          {options.length < 3 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="setup-choose-note">
              Showing {options.length} of 3 recommendation levels — the other options don&apos;t
              fit this device&apos;s memory or storage, so we don&apos;t offer them.
            </p>
          )}
          <fieldset className="space-y-1.5" data-testid="setup-options">
            <legend className="sr-only">Choose one model</legend>
            {options.map((o) => (
              <label
                key={o.id}
                data-testid={`setup-option-${o.id}`}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                  selected === o.id
                    ? "border-primary/60 bg-primary/5"
                    : "border-border bg-card hover:bg-muted/40"
                }`}
              >
                <input
                  type="radio"
                  name="nexuss-setup-model"
                  value={o.id}
                  checked={selected === o.id}
                  onChange={() => setSelected(o.id)}
                  className="mt-0.5 cursor-pointer"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">{o.label}</span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {TIER_LABEL[o.tier]}
                    </span>
                    {o.recommended && (
                      <span
                        className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
                        data-testid="setup-recommended-badge"
                      >
                        Recommended
                      </span>
                    )}
                    {o.installed && (
                      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600">
                        Installed
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                    {o.installed
                      ? "Already on this device — no download needed"
                      : `~${formatBytes(o.downloadBytes)} download`}
                    {o.ramBytes != null ? ` • needs ~${formatBytes(o.ramBytes)} memory` : ""}
                    {o.params ? ` • ${o.params}` : ""}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">{o.use}</span>
                  <span
                    className={`mt-0.5 block text-[10px] font-medium ${
                      o.compatible ? "text-emerald-600" : "text-amber-600"
                    }`}
                    data-testid={`setup-compat-${o.id}`}
                  >
                    {o.compatible
                      ? o.estimated
                        ? "Should fit — based on estimates"
                        : "Compatible with this device"
                      : "May not fit this device — resources unknown or tight"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setStep("confirm")}
              disabled={!selected}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-choose-continue"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() => setStep("check")}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-back"
            >
              Back
            </button>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Step 3: confirm ---------------- */}
      {step === "confirm" && selectedOption && (
        <div className="space-y-2.5" data-testid="setup-confirm">
          <p className="text-xs font-semibold text-foreground">
            {nothingToDo ? "Ready to connect local AI?" : "Ready to install local AI?"}
          </p>
          <div className="space-y-1 rounded-xl border border-border bg-card p-3">
            <InfoRow label="Provider" value="Ollama" />
            <InfoRow label="Model" value={`${selectedOption.label} (${selectedOption.id})`} />
            <InfoRow
              label="Provider status"
              value={
                facts.running
                  ? "Installed and running"
                  : needsInstallNow
                    ? "Needs installation"
                    : needsStartNow
                      ? "Installed but stopped — will try to start it"
                      : "Status unknown"
              }
            />
            <InfoRow
              label="Model status"
              value={
                selectedInstalled
                  ? "Already installed — no download"
                  : `Needs download (~${formatBytes(selectedOption.downloadBytes)})`
              }
            />
            <InfoRow
              label="Estimated download size"
              value={
                selectedInstalled ? "None" : `~${formatBytes(selectedOption.downloadBytes)}`
              }
              tag={selectedInstalled ? undefined : "estimate"}
            />
            <InfoRow
              label="Estimated additional storage"
              value={
                providerNeedsInstall || !selectedInstalled
                  ? formatBytes(
                      (providerNeedsInstall ? PROVIDER_INSTALL_ESTIMATE_BYTES : 0) +
                        (!selectedInstalled ? selectedOption.downloadBytes : 0)
                    )
                  : "None — everything is already on this device"
              }
              tag={
                providerNeedsInstall || !selectedInstalled ? "estimate" : undefined
              }
            />
          </div>

          {(selectedOption.estimated || device?.ramGB == null) && (
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="setup-confirm-warning">
              Hardware details are approximate, so download sizes and memory needs are estimates.
            </p>
          )}
          {!selectedOption.compatible && (
            <p role="alert" className="text-[11px] leading-relaxed text-amber-600" data-testid="setup-incompatible-warning">
              This model may not run well on this device. Pick a lighter option if setup is slow.
            </p>
          )}
          {storageDefinitivelyInsufficient && (
            <p role="alert" className="text-[11px] leading-relaxed text-destructive" data-testid="setup-storage-blocked">
              Not enough storage: about {formatBytes(totalAdditionalBytes)} is needed but only{" "}
              {formatBytes(freeBytes as number)} is free.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void startInstall()}
              disabled={storageDefinitivelyInsufficient}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-install-start"
            >
              {nothingToDo ? "Connect to Nexuss" : "Install and Connect"}
            </button>
            <button
              type="button"
              onClick={() => setStep("choose")}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-back"
            >
              Back
            </button>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Step 4: install / download / connect ---------------- */}
      {step === "install" && (
        <div className="space-y-3" data-testid="setup-install">
          <StepList steps={installLabels} current={installIndex} />

          {pullActive && (
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
              <button
                type="button"
                onClick={() => useLocalModelStore.getState().cancelPullOllamaModel()}
                className={SECONDARY_BUTTON_CLASSES}
                data-testid="setup-cancel-download"
              >
                Cancel Download
              </button>
            </div>
          )}

          {pullTask?.status === "cancelled" && (
            <div className="space-y-2" data-testid="setup-download-cancelled">
              <p className="text-[11px] text-muted-foreground">Download cancelled.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startInstall()}
                  className={PRIMARY_BUTTON_CLASSES}
                >
                  Try Again
                </button>
                <button
                  type="button"
                  onClick={() => setStep("confirm")}
                  className={SECONDARY_BUTTON_CLASSES}
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {installIssue === "need-install" && (
            <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-install-issue">
              <p className="text-xs font-semibold text-foreground">Ollama isn&apos;t installed yet</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Browsers can&apos;t install software on their own. Install Ollama from the official
                site, then continue — Nexuss picks up exactly where you left off.
              </p>
              <div className="flex flex-wrap gap-2">
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
                  onClick={() => void startInstall()}
                  className={SECONDARY_BUTTON_CLASSES}
                  data-testid="setup-check-again"
                >
                  Check Again
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {installIssue === "need-start" && (
            <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-install-issue">
              <p className="text-xs font-semibold text-foreground">
                Ollama is installed but not running
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Open the Ollama app on your computer, then continue.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startInstall()}
                  className={PRIMARY_BUTTON_CLASSES}
                  data-testid="setup-check-again"
                >
                  Check Again
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {installIssue === "unreachable" && (
            <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="setup-install-issue">
              <div className="flex items-center gap-2">
                <AlertTriangleIcon className="h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs font-semibold text-foreground">
                  Nexuss couldn&apos;t reach your local AI
                </p>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Make sure Ollama is running and the Nexuss local connector is started on this
                computer, then check again.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startInstall()}
                  className={PRIMARY_BUTTON_CLASSES}
                  data-testid="setup-check-again"
                >
                  Check Again
                </button>
                <button
                  type="button"
                  onClick={openAdvanced}
                  className={SECONDARY_BUTTON_CLASSES}
                  data-testid="setup-advanced"
                >
                  Advanced configuration
                </button>
                <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!installIssue && !pullActive && pullTask?.status !== "cancelled" && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          )}
        </div>
      )}

      {/* ---------------- Success ---------------- */}
      {step === "ready" && (
        <div className="space-y-2.5" data-testid="setup-ready">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
              <CheckIcon className="h-4 w-4 text-emerald-600" />
            </span>
            <p className="text-sm font-semibold text-foreground">Local AI is ready</p>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Ollama is connected to Nexuss.
          </p>
          <div className="space-y-1 rounded-xl border border-border bg-card p-3">
            <InfoRow label="Selected model" value={selected ?? "—"} />
            <InfoRow
              label="Available models"
              value={String(discovered.length || detection?.models?.length || 0)}
            />
            <InfoRow label="Connection status" value="Verified" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onClose}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-start-chatting"
            >
              Start chatting
            </button>
            <button
              type="button"
              onClick={onClose}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-done"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Failure ---------------- */}
      {step === "failed" && (
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
                setFailure(null);
                void startInstall();
              }}
              className={PRIMARY_BUTTON_CLASSES}
              data-testid="setup-retry"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                setFailure(null);
                setStep("confirm");
              }}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-back"
            >
              Back
            </button>
            <button
              type="button"
              onClick={openAdvanced}
              className={SECONDARY_BUTTON_CLASSES}
              data-testid="setup-advanced"
            >
              Advanced configuration
            </button>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASSES}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
