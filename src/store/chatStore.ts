import { create } from "zustand";
import { ChatState, Chat, Message, ProviderType } from "@/types";
import {
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_LIST,
  isValidModelForProvider
} from "@/types/providers";
import {
  getLastChatId,
  setLastChatId,
  getLocalTheme,
  setLocalTheme,
  getLocalProvider,
  setLocalProvider,
  getLocalModel,
  setLocalModel,
  clearAccountStorage
} from "@/storage/localStorage";
import { chatService, ChatStreamErrorEvent, ChatStreamUsageEvent } from "@/services/chat";
import { ApiError } from "@/services/api";
import { settingsService } from "@/services/settings";
import { generateTitle, getErrorMessage } from "@/utils";
import { ReasoningFilter } from "@/utils/reasoning";
import db from "@/lib/db/db";
import { useUsageStore } from "@/store/usageStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useLocalModelStore } from "@/store/localModelStore";
import { useWorkspaceStore } from "@/workspace/store";
import { streamLocalChat } from "@/services/localModels";
import { SYSTEM_PROMPT, PHI3_SYSTEM_PROMPT } from "@/services/localSystemPrompt";
import { PerfTracker } from "@/utils/localPerf";
import {
  extractChangeBlock,
  stripChangeBlock,
  extractCommandBlock,
  stripCommandBlock,
  hasCommandFence
} from "@/workspace/agent/parse";
import { stripAllFences, hasAnyFence, formatToolResults, executeFencedTools, MAX_AGENT_STEPS } from "@/workspace/agent/loop";
import { hasTerminalTag, extractTerminalTag } from "@/workspace/terminal";
import Dexie from "dexie";

interface ChatStore extends ChatState {
  theme: string;
  reset: (clearStorage?: boolean) => void;
  sendMessageStream: (content: string, image?: string) => Promise<void>;
  stopGeneration: () => void;
  createNewChat: () => Promise<Chat>;
  renameChat: (id: string, title: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  setProvider: (provider: ProviderType) => void;
  setModel: (model: string) => void;
  setTheme: (theme: string) => Promise<void>;
  clearError: () => void;
  hydrate: () => Promise<void>;
  searchChats: (query: string) => Promise<Chat[]>;
  editMessageAndRegenerate: (
    messageId: string,
    newContent: string,
    image?: string
  ) => Promise<void>;
  regenerateResponse: (messageId: string, image?: string) => Promise<void>;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function applyTheme(theme: string): void {
  if (typeof window === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// The authenticated Firebase UID is the single source of truth for ownership.
// It always comes from the auth store, never from the UI or localStorage.
function currentUid(): string | null {
  return useAuthStore.getState().user?.uid ?? null;
}

async function messagesForChat(uid: string, chatId: string): Promise<Message[]> {
  // Verify ownership before reading any message content.
  const chat = await db.chats.get(chatId);
  if (!chat || chat.userId !== uid) return [];
  // Use compound index when available for sorted, indexed retrieval. Falls back to sortBy if needed.
  try {
    return await db.messages
      .where("[chatId+timestamp]")
      .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
      .toArray();
  } catch {
    return db.messages.where("chatId").equals(chatId).sortBy("timestamp");
  }
}

// Persist the selection to Supabase so the backend /chat (which resolves
// provider/model from the user's settings) stays in lockstep with the UI.
// Non-fatal: chat requests carry explicit provider/model overrides, so a
// failed sync here never blocks sending a message.
function syncSettings(body: {
  provider?: string;
  model?: string;
  theme?: string;
}): void {
  settingsService.update(body).catch(() => {});
}

interface AttemptUsageEntry {
  provider: ProviderType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseTime: number;
  success: boolean;
}

// Record every provider attempt (primary + fallbacks) for usage tracking.
// Usage recording must never break the chat flow, so failures are swallowed.
async function recordAttempts(entries: AttemptUsageEntry[]): Promise<void> {
  try {
    for (const entry of entries) {
      await useUsageStore.getState().recordUsage(entry);
    }
  } catch {
    // ignore: usage tracking is best-effort
  }
}

interface ChatRequestHistory {
  role: string;
  content: string;
}

// Shown (and persisted) when a model reply is entirely internal reasoning with
// no recoverable answer. Storing an empty string would corrupt the next
// request's history (backend ChatTurn.content requires at least 1 char -> 422).
export const EMPTY_REPLY_FALLBACK =
  "I couldn't generate a complete response. Please try again or rephrase your question.";

// The in-flight generation's AbortController. Only one generation runs at a
// time (the store guards against concurrent sends); the Stop button aborts it
// through `stopGeneration`. The identity check in the request's `finally` makes
// sure a superseded request can never reset the state of a newer one.
let activeAbortController: AbortController | null = null;

// Shared request path for sending a user turn and streaming the assistant
// reply. Used by the initial send AND by edit/regenerate so that every path
// preserves provider routing, model selection, fallback behavior, streaming
// state, usage tracking, and error handling identically.
//
// Streaming: chunks are appended to a single assistant message in place as
// they arrive (visible immediately), the message is persisted to IndexedDB
// once the stream completes, and the reasoning filter is applied per chunk so
// markers never reach the screen even when split across chunk boundaries.
async function requestAssistant(
  chat: Chat,
  text: string,
  history: ChatRequestHistory[],
  image?: string
): Promise<void> {
  const state = useChatStore.getState();
  const provider = state.provider;
  const model = isValidModelForProvider(provider, state.model)
    ? state.model
    : DEFAULT_PROVIDER_MODELS[provider];
  const asstId = newId();

  // Register this request as the active generation so the Stop button can
  // abort it. Replaced synchronously when a new request starts, so cancelling
  // the previous one never interferes with a newer generation.
  const abortController = new AbortController();
  activeAbortController = abortController;

  useChatStore.setState({
    loading: true,
    error: null,
    isStreaming: true,
    streamingMessageId: asstId,
    fallbackNotice: null
  });

  // Create the streaming assistant message immediately (empty content) so the
  // UI can show the thinking indicator in place while waiting for the first
  // visible content chunk. It is updated in place as chunks arrive and only
  // persisted once with the final filtered text.
  useChatStore.setState((s) => ({
    messages: [
      ...s.messages,
      {
        id: asstId,
        chatId: chat.id,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now()
      }
    ]
  }));

  let usageEvent: ChatStreamUsageEvent | null = null;
  let errorEvent: ChatStreamErrorEvent | null = null;
  let display = "";

  const t0Global = typeof window !== 'undefined' ? (window as unknown as Record<string, number>).__nexussT0 : performance.now();
  const perf: PerfTracker = new PerfTracker();
  // Override start to be T0 if available for accurate T9-T0 — safe when PerfTracker disabled (production)
  const firstMark = perf.getMarks()[0];
  if (t0Global && firstMark && Math.abs(firstMark.ts - t0Global) > 5) {
    // PerfTracker already started at now, adjust? Keep separate mark
    perf.mark(`T1_requestAssistant_start T0_delta ${(performance.now()-t0Global).toFixed(1)}ms`);
  } else {
    perf.mark(`T1_requestAssistant_start`);
  }
  try {
    const startTime = performance.now();
    const reasoner = new ReasoningFilter();
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__nexussPerf = perf;
    // Batched UI updater: RAF-throttled to ~60fps to avoid per-token Zustand thrash,
    // while preserving TTFT (first token flushes immediately). measurable: reduces
    // React re-renders from N-per-token to ~16ms intervals without visible lag.
    let pendingFrame: number | null = null;
    let rafDisplay = "";
    let firstUpdateDone = false;
    const flushUpdate = () => {
      pendingFrame = null;
      useChatStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === asstId ? { ...m, content: rafDisplay } : m
        )
      }));
      if (!firstUpdateDone) {
        firstUpdateDone = true;
        perf.mark("T8_zustand_first_update");
        // T9 = first paint after Zustand - next frame
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(() => {
            perf.mark("T9_first_render");
            const t0v = typeof window !== 'undefined' ? (window as unknown as Record<string, number>).__nexussT0 : null;
            if (t0v) console.debug(`[Perf][T9] FIRST_VISIBLE_TOKEN T0→render ${(performance.now()-t0v).toFixed(1)}ms`);
          })
        } else {
          perf.mark("T9_first_render");
        }
      }
    };
    const scheduleUpdate = (content: string, immediate = false) => {
      rafDisplay = content;
      if (immediate) {
        if (pendingFrame !== null) {
          if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(pendingFrame);
          pendingFrame = null;
        }
        flushUpdate();
        return;
      }
      if (pendingFrame !== null) return;
      if (typeof requestAnimationFrame !== "undefined") {
        pendingFrame = requestAnimationFrame(() => flushUpdate());
      } else {
        // jsdom / node fallback - micro-batch
        pendingFrame = setTimeout(() => flushUpdate(), 16) as unknown as number;
      }
    };
    const updateMessage = (immediate = false) => {
      if (!firstUpdateDone && immediate) perf.mark("T7_first_visible_chunk_parsed");
      scheduleUpdate(display, immediate);
    };
    const flushPending = () => {
      if (pendingFrame !== null) {
        if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(pendingFrame);
        else clearTimeout(pendingFrame);
        pendingFrame = null;
        flushUpdate();
      }
    };

    if (provider === "local") {
      if (image) throw new Error("Local models do not support screen-share images yet. Please select a cloud vision model for image analysis.");
      const localState = useLocalModelStore.getState();
      let localModel = localState.models.find((m) => m.modelId === model && m.enabled);
      if (!localModel) localModel = localState.models.find((m) => m.enabled);
      if (!localModel) throw new Error("No local model configured. Add one in Settings → Models. No cloud API key is required for local chat.");
      const localProvider = localState.providers.find((p) => p.id === localModel!.providerId);
      if (!localProvider || !localProvider.enabled) throw new Error("Local provider not found or disabled. Check Settings → Models.");
      perf.mark("T2_request_preparation_start");
      perf.mark("request_preparation_start");
      const workspaceResult = useWorkspaceStore.getState().buildContextFor(text);
      const wsStateForPrompt = useWorkspaceStore.getState();
      const isPhi3 = localModel.modelId.toLowerCase().includes("phi3");
      const basePrompt = isPhi3 ? PHI3_SYSTEM_PROMPT : SYSTEM_PROMPT;
      const terminalStatus = wsStateForPrompt.panelOpen
        ? isPhi3
          ? "Terminal is OPEN — use <terminal>COMMAND</terminal> for inspection."
          : "Terminal panel is OPEN — terminal is available via ```workspace-command {\"run\":{\"command\":\"...\"}}``` and will be auto-executed."
        : isPhi3
          ? "Terminal is CLOSED — you do NOT have terminal access right now. Do NOT output <terminal>. Explain or answer directly without terminal."
          : "Terminal is CLOSED — you do NOT have terminal access. Do NOT use workspace-command. Explain or answer directly.";
      const allMessages: { role: string; content: string }[] = [
        { role: "system", content: basePrompt },
        { role: "system", content: terminalStatus },
        ...(workspaceResult?.contextText ? [{ role: "system" as const, content: `Workspace context:\n${workspaceResult.contextText}` }] : []),
        ...history,
        { role: "user", content: text },
      ];
      perf.mark("T2_end_request_preparation");
      perf.mark("request_preparation_end");
      if (process.env.NODE_ENV !== "production") {
        const cap = wsStateForPrompt;
        const ws = useWorkspaceStore.getState();
        console.debug(`[TerminalCapability] panelOpen:${cap.panelOpen} pathEnabled:${cap.pathEnabled} connected:${ws.connected} terminalAvailable:${cap.panelOpen} model:${localModel.modelId}`);
        console.debug("[Agent] user request", text.slice(0, 200));
        // Log exact LLM request messages (truncated, no secrets)
        console.debug(`[LLM Request] model=${localModel.modelId} messages=${allMessages.map(m=>`[${m.role}:${m.content.slice(0,180).replace(/\n/g,' ')}]`).join(' | ')}`);
      }
      perf.mark("T3_fetch_start");
      perf.mark("ollama_request_start");
      const stream = streamLocalChat({
        endpoint: localProvider.endpoint,
        modelId: localModel.modelId,
        messages: allMessages,
        apiKey: localProvider.apiKey,
        signal: abortController.signal,
      });
      let ttftDone = false;
      let firstVisible = true;
      for await (const evt of stream) {
        if (evt.type === "chunk") {
          if (!ttftDone) { perf.mark("ttft"); ttftDone = true; }
          const visible = reasoner.push(evt.content);
          if (!visible) continue;
          display += visible;
          if (firstVisible) { updateMessage(true); firstVisible = false; }
          else updateMessage();
        } else if (evt.type === "done") {
          const tail = reasoner.flush();
          if (tail) {
            display += tail;
            updateMessage(true);
          }
        }
      }
      // Ensure tail is flushed even if stream ended without explicit done
      const tail = reasoner.flush();
      if (tail) {
        display += tail;
        updateMessage(true);
      }
      flushPending();
      perf.mark("T10_final_token");
      perf.mark("model_generation_complete");
      perf.mark("T11_final_render");
      // Log full T0 breakdown
      try {
        const t0v = typeof window !== 'undefined' ? (window as unknown as Record<string, number>).__nexussT0 : null;
        if (t0v) {
          const marks = perf.getMarks();
          const get = (label:string)=> marks.find(m=>m.label.includes(label))?.delta ?? 0;
          console.debug(`[Perf][TIMING_MAP] T1-T0 ${(get("T1")-0).toFixed(1)} | T2-T1 ${(get("T2_end")-get("T1")).toFixed(1)} | T3-T2 ${(get("T3")-get("T2_end")).toFixed(1)} | T8-T3 ${(get("T8")-get("T3")).toFixed(1)} | T9-T8 ${(get("T9")-get("T8")).toFixed(1)} | T10-T9 ${(get("T10")-get("T9")).toFixed(1)} | FIRST_VISIBLE ${(get("T9")||0).toFixed(1)} | TOTAL ${(get("T11")||0).toFixed(1)}`);
        }
      } catch {}
      perf.logSummary();
    } else {
      // Cloud path: via backend
      const workspaceResult = useWorkspaceStore.getState().buildContextFor(text);
      const events = chatService.sendStream(
        {
          message: text,
          history,
          provider: provider as Exclude<ProviderType, "local">,
          model,
          image,
          workspaceContext: workspaceResult?.contextText
        },
        { signal: abortController.signal }
      );
      const responseTime = performance.now() - startTime;

      let cloudFirst = true;
      for await (const event of events) {
        if (event.type === "chunk") {
          const visible = reasoner.push(event.content);
          if (!visible) continue;
          display += visible;
          if (cloudFirst) { updateMessage(true); cloudFirst = false; } else updateMessage();
        } else if (event.type === "usage") {
          usageEvent = event;
          if (event.fallback_used) {
            useChatStore.setState({ fallbackNotice: event.fallback_used });
          }
        } else if (event.type === "error") {
          errorEvent = event;
        }
      }

      const tail = reasoner.flush();
      if (tail) {
        display += tail;
        updateMessage(true);
      }
      flushPending();

      // Record usage for EVERY attempted request (primary + fallbacks).
      const attempts = usageEvent?.attempts ?? errorEvent?.attempts ?? [];
      if (attempts.length > 0) {
        await recordAttempts(
          attempts.map((a) => ({
            provider: a.provider as ProviderType,
            model: a.model,
            inputTokens: a.input_tokens ?? 0,
            outputTokens: a.output_tokens ?? 0,
            totalTokens: a.total_tokens ?? 0,
            responseTime: a.response_time_ms ?? 0,
            success: a.status === "success"
          }))
        );
      } else if (usageEvent) {
        await recordAttempts([
          {
            provider: (usageEvent.provider || provider) as ProviderType,
            model: usageEvent.model || model,
            inputTokens: usageEvent.usage?.input_tokens ?? 0,
            outputTokens: usageEvent.usage?.output_tokens ?? 0,
            totalTokens: usageEvent.usage?.total_tokens ?? 0,
            responseTime: Math.round(responseTime),
            success: true
          }
        ]);
      } else if (errorEvent) {
        await recordAttempts([
          {
            provider: provider as ProviderType,
            model,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            responseTime: 0,
            success: false
          }
        ]);
      }

      if (errorEvent) {
        useChatStore.setState({ error: errorEvent.message });
      }

      if (usageEvent && !image) {
        const latest = useChatStore.getState();
        if (usageEvent.provider && usageEvent.provider !== latest.provider) {
          useChatStore.setState({ provider: usageEvent.provider as ProviderType });
        }
        if (usageEvent.model && usageEvent.model !== latest.model) {
          useChatStore.setState({ model: usageEvent.model });
        }
      }
    }

    // — Autonomous agent loop: when Path is ON and model emits fences,
    // execute tools and feed results back to the model within the SAME
    // assistant turn (up to MAX_AGENT_STEPS). For in-memory/demo workspaces
    // tools auto-apply so ONE user message can complete discover→read→edit→run→fix→verify.
    // For native workspaces tools stage for approval and loop pauses (existing UX).
    const wsForLoop = useWorkspaceStore.getState();
    const hasCommand = !!extractCommandBlock(display) || hasCommandFence(display);
    const hasTerminal = hasTerminalTag(display) || !!extractTerminalTag(display);
    const hasChange = !!extractChangeBlock(display);
    // TERMINAL != FILESYSTEM: terminal is autonomous once Terminal panel is open (panelOpen)
    // Filesystem changes still require pathEnabled+in-memory+autoLoop
    const shouldAutonomousLoop = hasAnyFence(display) && wsForLoop.panelOpen && (hasCommand || hasTerminal || (hasChange && wsForLoop.pathEnabled && wsForLoop.workspace?.kind === "in-memory" && wsForLoop.agentAutoLoop));
    let finalContent: string;
    const loopDisplay = display;
    const loopHistory = [...history];
    // Preserve original single-shot behavior for native or Path OFF
    if (shouldAutonomousLoop && !abortController.signal.aborted) {
      let steps = 0;
      let currentDisplay = loopDisplay;
      let currentHistory = [...loopHistory];
      while (steps < MAX_AGENT_STEPS && hasAnyFence(currentDisplay) && !abortController.signal.aborted) {
        perf?.mark(`terminal_parse_start_step${steps + 1}`);
        const execStart = performance.now();
        perf?.mark(`terminal_execute_start_step${steps + 1}`);
        const exec = await executeFencedTools(currentDisplay);
        const execDur = performance.now() - execStart;
        if (process.env.NODE_ENV !== "production") console.debug(`[Perf] terminal exec step ${steps + 1} ${execDur.toFixed(1)}ms results=${exec.results.length}`);
        perf?.mark(`terminal_execute_end_step${steps + 1}`);
        if (exec.results.length === 0) break;
        if (exec.needsApproval) {
          // Native-like pause not expected for in-memory; fall back to staging
          break;
        }
        const toolText = formatToolResults(exec.results);
        // Show tool progress in the streaming message (immediate)
        display = `${exec.stripped}\n\n${toolText}`;
        updateMessage(true);
        // Feed stripped assistant + tool results to next LLM call
        currentHistory = [...currentHistory, { role: "assistant", content: exec.stripped }, { role: "system", content: toolText }];
        perf?.mark(`second_model_request_start_step${steps + 1}`);
        // Fetch next model iteration with updated history (reuse same provider/model/reasoner)
        // Reset for next fetch
        const nextReasoner = new ReasoningFilter();
        let nextDisplay = "";
        let nextPending: number | null = null;
        let nextRafDisplay = "";
        const flushNext = () => {
          nextPending = null;
          useChatStore.setState((s) => ({
            messages: s.messages.map((m) => (m.id === asstId ? { ...m, content: nextRafDisplay } : m))
          }));
        };
        const nextUpdate = (immediate = false) => {
          nextRafDisplay = nextDisplay;
          if (immediate) {
            if (nextPending !== null) { if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(nextPending); else clearTimeout(nextPending); nextPending = null; }
            flushNext(); return;
          }
          if (nextPending !== null) return;
          if (typeof requestAnimationFrame !== "undefined") nextPending = requestAnimationFrame(() => flushNext());
          else nextPending = setTimeout(() => flushNext(), 16) as unknown as number;
        };
        // Duplicate provider branching for next iteration using currentHistory as context
        if (provider === "local") {
          const localState = useLocalModelStore.getState();
          let localModel = localState.models.find((m) => m.modelId === model && m.enabled);
          if (!localModel) localModel = localState.models.find((m) => m.enabled);
          if (!localModel) { nextDisplay = exec.stripped; break; }
          const localProvider = localState.providers.find((p) => p.id === localModel!.providerId);
          if (!localProvider) { nextDisplay = exec.stripped; break; }
          // Reuse original workspace context to avoid rebuilding search index twice for same question
          const wsResCached = useWorkspaceStore.getState().buildContextFor(text);
          const cachedWsText = wsResCached?.contextText;
          const isPhi3Loop = localModel.modelId.toLowerCase().includes("phi3");
          const loopPrompt = isPhi3Loop ? PHI3_SYSTEM_PROMPT : SYSTEM_PROMPT;
          const allMessages: { role: string; content: string }[] = [
            { role: "system", content: loopPrompt },
            ...(cachedWsText ? [{ role: "system" as const, content: `Workspace context:\n${cachedWsText}` }] : []),
            ...currentHistory,
            { role: "user", content: text }
          ];
          // Also inject toolText as additional system for immediate next turn visibility
          allMessages.splice(allMessages.length - 1, 0, { role: "system", content: toolText });
          try {
            const stream = streamLocalChat({ endpoint: localProvider.endpoint, modelId: localModel.modelId, messages: allMessages, apiKey: localProvider.apiKey, signal: abortController.signal });
            let firstNext = true;
            let secondTtftDone = false;
            for await (const evt of stream) {
              if (evt.type === "chunk") {
                const v = nextReasoner.push(evt.content);
                if (!v) continue;
                if (!secondTtftDone) { perf?.mark(`second_ttft_step${steps + 1}`); secondTtftDone = true; }
                nextDisplay += v;
                if (firstNext) { nextUpdate(true); firstNext = false; } else nextUpdate();
              } else if (evt.type === "done") {
                const t = nextReasoner.flush();
                if (t) { nextDisplay += t; nextUpdate(true); }
              }
            }
            const t = nextReasoner.flush();
            if (t) { nextDisplay += t; nextUpdate(true); }
            if (nextPending !== null) { if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(nextPending); else clearTimeout(nextPending); nextPending = null; flushNext(); }
            perf?.mark(`second_model_complete_step${steps + 1}`);
          } catch {
            nextDisplay = exec.stripped;
            break;
          }
        } else {
          const wsRes = useWorkspaceStore.getState().buildContextFor(text);
          try {
            const events = chatService.sendStream({ message: `${text}\n\n${toolText}`, history: currentHistory, provider: provider as Exclude<ProviderType, "local">, model, workspaceContext: wsRes?.contextText }, { signal: abortController.signal });
            let firstNext2 = true;
            for await (const event of events) {
              if (event.type === "chunk") {
                const v = nextReasoner.push(event.content);
                if (!v) continue;
                nextDisplay += v;
                if (firstNext2) { nextUpdate(true); firstNext2 = false; } else nextUpdate();
              }
            }
            const t = nextReasoner.flush();
            if (t) { nextDisplay += t; nextUpdate(true); }
            if (nextPending !== null) { if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(nextPending); else clearTimeout(nextPending); nextPending = null; flushNext(); }
          } catch {
            nextDisplay = exec.stripped;
            break;
          }
        }
        display = nextDisplay;
        currentDisplay = nextDisplay;
        steps++;
        if (!hasAnyFence(currentDisplay)) break;
      }
      perf?.mark("final_response");
      perf?.logSummary();
      finalContent = stripAllFences(currentDisplay).trim() || EMPTY_REPLY_FALLBACK;
      // Also append lastCommandResult if one exists from auto-applied commands (rare for in-memory)
      if (useWorkspaceStore.getState().lastCommandResult) {
        const last = useWorkspaceStore.getState().lastCommandResult;
        if (last) {
          const resultText = [`## Last command result`, `Command: \`${last.command}\``, `Exit: ${last.exitCode ?? "n/a"}`, ...(last.stdout ? [`\`\`\`\n${last.stdout}\n\`\`\``] : []), ...(last.stderr ? [`Stderr:\n\`\`\`\n${last.stderr}\n\`\`\``] : [])].join("\n");
          useWorkspaceStore.getState().clearLastCommandResult();
          finalContent = `${finalContent}\n\n${resultText}`;
        }
      }
    } else {
      const filtered = loopDisplay.trim();
      const changeBlock = extractChangeBlock(filtered);
      let stagedContent =
        filtered.length > 0 ? stripChangeBlock(filtered) : EMPTY_REPLY_FALLBACK;
      if (changeBlock) {
        void useWorkspaceStore
          .getState()
          .proposeChangeFromBlock(changeBlock.changes)
          .catch(() => {});
      }
      const commandBlock = extractCommandBlock(stagedContent);
      if (commandBlock || hasCommandFence(stagedContent)) {
        stagedContent = stripCommandBlock(stagedContent) || EMPTY_REPLY_FALLBACK;
        if (commandBlock) {
          void useWorkspaceStore
            .getState()
            .proposeCommandFromBlock(commandBlock)
            .catch(() => {});
        }
      }
      // Always strip terminal fence from non-executed path so raw tags never leak to UI
      if (hasTerminalTag(stagedContent)) {
        stagedContent = stripAllFences(stagedContent) || EMPTY_REPLY_FALLBACK;
      }
      finalContent = stagedContent;
      if (useWorkspaceStore.getState().lastCommandResult) {
        const last = useWorkspaceStore.getState().lastCommandResult;
        if (last) {
          const resultText = [
            `## Last command result (previous turn)`,
            `Command: \`${last.command}\``,
            `Cwd: \`${last.cwd || "(workspace root)"}\``,
            `Exit: ${last.exitCode ?? "n/a"} (${last.timedOut ? "timed out" : last.killed ? "killed" : "completed"})`,
            `Duration: ${last.durationMs}ms`,
            ...(last.stdout ? [`\`\`\`\n${last.stdout}\n\`\`\``] : []),
            ...(last.stderr ? [`Stderr:\n\`\`\`\n${last.stderr}\n\`\`\``] : [])
          ].join("\n");
          useWorkspaceStore.getState().clearLastCommandResult();
          finalContent = `${finalContent}\n\n${resultText}`;
        }
      }
      display = finalContent;
      updateMessage(true);
      flushPending();
    }

    const asstMsg: Message = {
      id: asstId,
      chatId: chat.id,
      role: "assistant",
      content: finalContent,
      timestamp: Date.now()
    };
    // Persist the completed assistant message (chunks were shown live but
    // only the final filtered text is stored).
    await db.messages.add(asstMsg);
    await db.chats.update(chat.id, { updatedAt: asstMsg.timestamp });
    useChatStore.setState((s) => {
      const exists = s.messages.some((m) => m.id === asstId);
      const mapped = s.messages.map((m) =>
        m.id === asstId
          ? { ...m, content: finalContent, timestamp: asstMsg.timestamp }
          : m
      );
      return {
        messages: exists ? mapped : [...mapped, asstMsg],
        currentChat: s.currentChat
          ? { ...s.currentChat, updatedAt: asstMsg.timestamp }
          : s.currentChat,
        chats: s.chats.map((c) =>
          c.id === chat.id ? { ...c, updatedAt: asstMsg.timestamp } : c
        )
      };
    });
  } catch (e: unknown) {
    // Record every failed attempt from the backend when the error body
    // carried the attempt log; otherwise record a single failed entry.
    const errorAttempts = e instanceof ApiError ? e.attempts : undefined;
    const current = useChatStore.getState();
    if (errorAttempts && errorAttempts.length > 0) {
      await recordAttempts(
        errorAttempts.map((a) => ({
          provider: a.provider as ProviderType,
          model: a.model,
          inputTokens: a.input_tokens ?? 0,
          outputTokens: a.output_tokens ?? 0,
          totalTokens: a.total_tokens ?? 0,
          responseTime: a.response_time_ms ?? 0,
          success: false
        }))
      );
    } else {
      await recordAttempts([
        {
          provider: current.provider,
          model: current.model,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responseTime: 0,
          success: false
        }
      ]);
    }
    // An intentional user stop (Stop button) is NOT an error: keep whatever was
    // already streamed on screen and never surface an error banner. The fetch
    // itself aborts via the controller; timeouts/stalls abort the internal
    // controller only, so the external signal being aborted means the user
    // cancelled the request.
    if (!abortController.signal.aborted) {
      useChatStore.setState({ error: getErrorMessage(e) });
    }
  } finally {
    // If the stream produced no visible content at all (the request itself
    // threw before any chunk), drop the empty placeholder so no blank
    // assistant bubble lingers next to the error.
    const settled = useChatStore.getState();
    const asst = settled.messages.find((m) => m.id === asstId);
    if (asst && asst.content.trim() === "") {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== asstId)
      }));
    }
    // Only the request that is still current may clear the generation state. If
    // the user stopped this request and already started a new one, the new
    // request owns the state from here on.
    if (activeAbortController === abortController) {
      activeAbortController = null;
      useChatStore.setState({
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
    }
  }
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  currentChat: null,
  chats: [],
  messages: [],
  provider: "groq",
  model: DEFAULT_PROVIDER_MODELS.groq,
  loading: false,
  error: null,
  isStreaming: false,
  streamingMessageId: null,
  fallbackNotice: null,
  theme: "light",

  reset: (clearStorage = false) => {
    set({
      currentChat: null,
      chats: [],
      messages: [],
      provider: "groq",
      model: DEFAULT_PROVIDER_MODELS.groq,
      loading: false,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      theme: "light"
    });
    if (clearStorage) {
      applyTheme("light");
      clearAccountStorage();
    }
  },

  clearError: () => set({ error: null }),

  setProvider: (provider) => {
    if (!PROVIDER_LIST.includes(provider)) return;
    let model = DEFAULT_PROVIDER_MODELS[provider];
    if (provider === "local") {
      const enabled = useLocalModelStore.getState().models.filter((m) => m.enabled);
      if (enabled.length > 0) model = enabled[0].modelId;
    }
    set({ provider, model });
    setLocalProvider(provider);
    setLocalModel(model);
    if (provider !== "local") syncSettings({ provider, model });
  },

  setModel: (model) => {
    // A model is only valid for the provider it belongs to. Reject anything
    // else instead of saving (and later sending) an invalid combination.
    const provider = get().provider;
    if (!isValidModelForProvider(provider, model)) return;
    set({ model });
    setLocalModel(model);
    if (provider !== "local") syncSettings({ model });
  },

  setTheme: async (theme) => {
    set({ theme });
    applyTheme(theme);
    setLocalTheme(theme);
    syncSettings({ theme });
  },

  hydrate: async () => {
    // Guard against duplicate concurrent hydration (StrictMode double-mount,
    // auth token refresh, or multiple components calling hydrate). Returns the
    // in-flight promise for the same UID so only one DB query runs.
    const uid = currentUid();
    // Performance instrumentation: measure total hydration and sub-steps.
    const mark = (name: string) => {
      if (typeof performance !== "undefined" && performance.mark) {
        try {
          performance.mark(name);
        } catch {}
      }
    };
    const measureLog = (label: string, start: number) => {
      const dur = performance.now() - start;
      if (process.env.NODE_ENV !== "production") {
        console.debug(`[hydrate] ${label}: ${dur.toFixed(1)}ms`);
      }
    };

    // Use module-level guard
    const g = globalThis as unknown as {
      __nexussHydratePromise?: Promise<void> | null;
      __nexussHydrateUid?: string | null;
    };
    if (g.__nexussHydratePromise && g.__nexussHydrateUid === (uid ?? null)) {
      return g.__nexussHydratePromise;
    }

    const promise = (async () => {
      const t0 = performance.now();
      mark("chat-hydration-start");
      try {
        const theme = getLocalTheme();
        let chats: Chat[] = [];
        let currentChat: Chat | null = null;
        let messages: Message[] = [];

        // If no authenticated user exists, load ZERO account-owned chats.
        if (uid) {
          const tChats = performance.now();
          chats = await db.chats
            .where("[userId+updatedAt]")
            .between([uid, Dexie.minKey], [uid, Dexie.maxKey])
            .reverse()
            .toArray();
          measureLog(`chats query (${chats.length} chats)`, tChats);

          const lastChat = getLastChatId(uid);
          const target = lastChat
            ? chats.find((c) => c.id === lastChat)
            : chats[0] || null;
          if (target) {
            currentChat = target;
            const tMsgs = performance.now();
            messages = await messagesForChat(uid, target.id);
            measureLog(`messages query (${messages.length} msgs)`, tMsgs);
          }
        } else {
          // Ensure unauthenticated users never see stale state from previous account
          chats = [];
          currentChat = null;
          messages = [];
        }
        let provider = (getLocalProvider() as ProviderType) || "groq";
        if (!PROVIDER_LIST.includes(provider)) provider = "groq";
        let model = getLocalModel() || DEFAULT_PROVIDER_MODELS[provider];
        if (!isValidModelForProvider(provider, model)) {
          model = DEFAULT_PROVIDER_MODELS[provider];
        }
        // Critical: update UI immediately with local data (metadata + selected messages).
        // Do not block on remote settings fetch.
        set({
          chats,
          currentChat,
          messages,
          provider,
          model,
          fallbackNotice: null,
          theme
        });
        applyTheme(theme);
        setLocalTheme(theme);
        measureLog("local hydration (chats+messages+theme)", t0);
        mark("chat-hydration-local-end");

        if (!uid) {
          mark("chat-hydration-end");
          return;
        }

        // Non-critical: reconcile UI selection with Supabase settings in background.
        // Must not block "Loading your chats..." spinner.
        const tRemote = performance.now();
        const initialProvider = provider;
        const initialModel = model;
        const initialTheme = theme;
        void (async () => {
          try {
            const remote = await settingsService.get();
            let remoteProvider = (remote.provider as ProviderType) || provider;
            if (!PROVIDER_LIST.includes(remoteProvider)) remoteProvider = provider;
            let remoteModel = remote.model || DEFAULT_PROVIDER_MODELS[remoteProvider];
            if (!isValidModelForProvider(remoteProvider, remoteModel)) {
              remoteModel = DEFAULT_PROVIDER_MODELS[remoteProvider];
            }
            // Only apply if the same user is still signed in (prevents race on account switch)
            // And don't overwrite if user has already changed provider/model (e.g., fallback or local selection)
            if (currentUid() === uid) {
              const cur = useChatStore.getState();
              const shouldUpdateProvider = cur.provider === initialProvider && cur.model === initialModel;
              if (cur.provider === "local") {
                measureLog("remote settings fetch (skipped for local)", tRemote);
                // Still sync theme if remote has one and user hasn't changed theme
                if (cur.theme === initialTheme && remote.theme && remote.theme !== cur.theme) {
                  set({ theme: remote.theme });
                  applyTheme(remote.theme);
                  setLocalTheme(remote.theme);
                }
              } else if (shouldUpdateProvider) {
                set({
                  provider: remoteProvider,
                  model: remoteModel,
                  theme: remote.theme || theme
                });
                applyTheme(remote.theme || theme);
                setLocalTheme(remote.theme || theme);
                setLocalProvider(remoteProvider);
                setLocalModel(remoteModel);
              } else {
                // Provider/model already changed (e.g., fallback), don't overwrite — only sync theme if needed
                if (remote.theme && remote.theme !== cur.theme) {
                  set({ theme: remote.theme });
                  applyTheme(remote.theme);
                  setLocalTheme(remote.theme);
                }
              }
            }
            measureLog("remote settings fetch", tRemote);
          } catch {
            // Local values already applied; nothing to surface.
            measureLog("remote settings fetch (failed)", tRemote);
          } finally {
            mark("chat-hydration-end");
            try {
              if (performance.measure) {
                performance.measure("chat-hydration", "chat-hydration-start", "chat-hydration-end");
                performance.measure("chat-hydration-local", "chat-hydration-start", "chat-hydration-local-end");
              }
            } catch {}
          }
        })();

        // Mark local hydration as complete for measurement; remote will complete separately.
        try {
          if (performance.measure) {
            performance.measure("chat-hydration-local", "chat-hydration-start", "chat-hydration-local-end");
          }
        } catch {}
      } catch (e) {
        set({ error: getErrorMessage(e) });
        mark("chat-hydration-end");
      }
    })();

    g.__nexussHydratePromise = promise;
    g.__nexussHydrateUid = uid ?? null;
    try {
      await promise;
    } finally {
      // Clear guard after completion so next user switch can hydrate again.
      // We keep uid to dedupe rapid duplicate calls for same user.
      if (g.__nexussHydrateUid === (uid ?? null)) {
        g.__nexussHydratePromise = null;
      }
    }
  },

  createNewChat: async () => {
    const uid = currentUid();
    if (!uid) throw new Error("Not authenticated");
    const chat: Chat = {
      id: newId(),
      userId: uid,
      title: "New chat",
      provider: get().provider,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.chats.add(chat);
    set((state) => ({
      chats: [chat, ...state.chats],
      currentChat: chat,
      messages: []
    }));
    setLastChatId(uid, chat.id);
    return chat;
  },

  loadChat: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const chat = get().chats.find((c) => c.id === id);
    if (!chat || chat.userId !== uid) return;
    const messages = await messagesForChat(uid, id);
    set({ currentChat: chat, messages });
    setLastChatId(uid, id);
  },

  renameChat: async (id, title) => {
    const uid = currentUid();
    const trimmed = title.trim();
    if (!trimmed || !uid) return;
    const existing = await db.chats.get(id);
    if (!existing || existing.userId !== uid) return;
    const updatedAt = Date.now();
    await db.chats.update(id, { title: trimmed, updatedAt });
    set((state) => ({
      chats: state.chats.map((c) => (c.id === id ? { ...c, title: trimmed, updatedAt } : c)),
      currentChat:
        state.currentChat?.id === id
          ? { ...state.currentChat, title: trimmed, updatedAt }
          : state.currentChat
    }));
  },

  deleteChat: async (id) => {
    const uid = currentUid();
    if (!uid) return;
    const existing = await db.chats.get(id);
    if (!existing || existing.userId !== uid) return;
    try {
      await db.transaction("rw", db.chats, db.messages, async () => {
        await db.chats.delete(id);
        await db.messages.where("chatId").equals(id).delete();
      });
    } catch (e) {
      set({ error: getErrorMessage(e) });
      return;
    }
    const wasCurrent = get().currentChat?.id === id;
    set((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
      currentChat: wasCurrent ? null : state.currentChat,
      messages: wasCurrent ? [] : state.messages,
      isStreaming: wasCurrent ? false : state.isStreaming,
      streamingMessageId: wasCurrent ? null : state.streamingMessageId,
      error: null
    }));
    if (getLastChatId(uid) === id) {
      setLastChatId(uid, wasCurrent ? null : get().currentChat?.id ?? null);
    }
  },

  searchChats: async (query) => {
    const uid = currentUid();
    const q = query.toLowerCase().trim();
    const chats = get().chats.filter((c) => c.userId === uid);
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  },

  sendMessageStream: async (content, image) => {
    const t0 = performance.now();
    if (typeof window !== 'undefined') (window as unknown as Record<string, number>).__nexussT0 = t0;
    if (process.env.NODE_ENV !== 'production') console.debug(`[Perf][T0] user_submit t0=${t0.toFixed(1)}`);
    const text = content.trim();
    if (!text) return;

    const current = get();
    if (current.loading || current.isStreaming) return;
    // Set the in-flight flag synchronously so a second send issued before the
    // first reaches its first await can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });

    // The entire flow is wrapped so any failure (local DB, network, provider)
    // surfaces as a user-visible error instead of failing silently.
    try {
      const uid = currentUid();
      let currentChat = get().currentChat;
      if (currentChat && currentChat.userId !== uid) {
        // Never allow a chat owned by another account to be reused or its
        // context sent to the backend.
        currentChat = null;
      }
      if (!currentChat) {
        currentChat = await get().createNewChat();
      }

      const userMsg: Message = {
        id: newId(),
        chatId: currentChat.id,
        role: "user",
        content: text,
        timestamp: Date.now()
      };

      // Show the user's message immediately; persistence runs right after so a
      // reload mid-request still keeps history intact. Chat history lives in
      // IndexedDB; the backend only receives the last 99 prior turns for
      // context and never stores anything.
      const updatedAt = Date.now();
      set((state) => ({
        messages: [...state.messages, userMsg],
        loading: true,
        error: null,
        isStreaming: false,
        streamingMessageId: null,
        fallbackNotice: null,
        currentChat: state.currentChat
          ? { ...state.currentChat, updatedAt }
          : state.currentChat,
        chats: state.chats.map((c) =>
          c.id === currentChat!.id ? { ...c, updatedAt } : c
        )
      }));
      await db.messages.add(userMsg);
      await db.chats.update(currentChat.id, { updatedAt });

      const history = get()
        .messages.filter(
          (m) =>
            m.chatId === currentChat!.id &&
            m.id !== userMsg.id &&
            m.content.trim().length > 0
        )
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-99);

      // No API key is sent to the backend. The backend resolves the key for
      // this provider from the user's Supabase-stored keys. Provider/model are
      // sent explicitly so the UI selection is always what the backend uses.
      // An optional `image` (a single fresh screen-share frame) is attached to
      // this request only; it is transient and never stored with the message.
      await requestAssistant(currentChat, text, history, image);

      const title = get().chats.find((c) => c.id === currentChat!.id)?.title;
      if (title === "New chat") {
        await get().renameChat(currentChat!.id, generateTitle(text));
      }
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
    }
  },

  // Cancel the active generation: abort the streaming request and reset the
  // generation state so the Send button returns immediately. Whatever was
  // already streamed stays on screen; the request's catch/finally treats this
  // as a user-initiated stop, not an error. Cancelling the old controller makes
  // it impossible for a stopped generation to keep updating the UI.
  stopGeneration: () => {
    const controller = activeAbortController;
    activeAbortController = null;
    if (controller) controller.abort();
    set({
      loading: false,
      isStreaming: false,
      streamingMessageId: null,
      error: null
    });
  },

  // Replace an existing user message and everything generated after it, then
  // resubmit the edited text through the exact same request path as a normal
  // send (same provider/model routing, fallbacks, streaming, usage, errors).
  // While screen sharing is active, `image` carries the fresh frame captured
  // at send time so the edit is analyzed against the current screen too.
  editMessageAndRegenerate: async (messageId, newContent, image) => {
    const text = newContent.trim();
    if (!text) return;

    const uid = currentUid();
    if (!uid) return;
    const currentChat = get().currentChat;
    if (!currentChat || currentChat.userId !== uid) return;

    const current = get();
    if (current.loading || current.isStreaming) return;

    const messages = get().messages;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = messages[idx];
    if (target.role !== "user" || target.chatId !== currentChat.id) return;

    const editedMsg: Message = {
      id: newId(),
      chatId: currentChat.id,
      role: "user",
      content: text,
      timestamp: Date.now()
    };

    // Remove the edited message and every subsequent message (the old
    // assistant reply and anything after it) so history stays consistent.
    const removed = messages.slice(idx);
    const removedIds = removed.map((m) => m.id);
    const kept = messages.slice(0, idx);
    // Set the in-flight flag synchronously (before the first await) so a
    // racing regenerate/edit/send can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.messages.add(editedMsg);
        await db.chats.update(currentChat.id, { updatedAt: editedMsg.timestamp });
      });
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
      return;
    }

    set((state) => ({
      messages: [...kept, editedMsg],
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      currentChat: state.currentChat
        ? { ...state.currentChat, updatedAt: editedMsg.timestamp }
        : state.currentChat,
      chats: state.chats.map((c) =>
        c.id === currentChat.id
          ? { ...c, updatedAt: editedMsg.timestamp }
          : c
      )
    }));

    const history = kept
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-99);
    await requestAssistant(currentChat, text, history, image);
  },

  // Regenerate the assistant response for the preceding user turn. The
  // regenerated reply replaces the current assistant message and everything
  // generated after it, and reuses the existing request path so provider,
  // model, fallbacks, streaming, usage, and error handling are unchanged.
  // While screen sharing is active, `image` carries the fresh frame captured
  // at send time so the re-answer also sees the current screen.
  regenerateResponse: async (messageId, image) => {
    const uid = currentUid();
    if (!uid) return;
    const currentChat = get().currentChat;
    if (!currentChat || currentChat.userId !== uid) return;

    const current = get();
    if (current.loading || current.isStreaming) return;

    const messages = get().messages;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = messages[idx];
    if (target.role !== "assistant" || target.chatId !== currentChat.id) return;

    // The immediately preceding user message is the prompt being re-answered.
    const userIdx = idx - 1;
    if (userIdx < 0 || messages[userIdx].role !== "user") return;
    const userText = messages[userIdx].content;

    // Drop this assistant message and everything after it; keep prior turns.
    const removed = messages.slice(idx);
    const removedIds = removed.map((m) => m.id);
    const kept = messages.slice(0, idx);
    const updatedAt = Date.now();
    // Set the in-flight flag synchronously (before the first await) so a
    // racing regenerate/edit/send can never slip through the guard.
    set({ loading: true, error: null, isStreaming: false, fallbackNotice: null });
    try {
      await db.transaction("rw", db.messages, db.chats, async () => {
        if (removedIds.length > 0) {
          await db.messages.where("id").anyOf(removedIds).delete();
        }
        await db.chats.update(currentChat.id, { updatedAt });
      });
    } catch (e: unknown) {
      set({
        error: getErrorMessage(e),
        loading: false,
        isStreaming: false,
        streamingMessageId: null
      });
      return;
    }

    set((state) => ({
      messages: kept,
      loading: true,
      error: null,
      isStreaming: false,
      streamingMessageId: null,
      fallbackNotice: null,
      currentChat: state.currentChat
        ? { ...state.currentChat, updatedAt }
        : state.currentChat,
      chats: state.chats.map((c) =>
        c.id === currentChat.id ? { ...c, updatedAt } : c
      )
    }));

    // The user message being re-answered is sent as the request `message`;
    // history is everything before it.
    const history = kept
      .slice(0, userIdx)
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-99);
    await requestAssistant(currentChat, userText, history, image);
  }
}));
