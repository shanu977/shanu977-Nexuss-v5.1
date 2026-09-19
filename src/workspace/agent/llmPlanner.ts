// LLM Planner: Understands natural language via Ollama and produces structured AgentPlan
// Falls back to deterministic planner when LLM unavailable or in tests

import type { AgentPlan } from "./llmTypes";
import { AGENT_SYSTEM_PROMPT } from "./llmTypes";
import { buildAgentContext, formatContextForLLM } from "./agentContext";
import { planFilesystemActions as deterministicPlan, hasExplicitTarget, isFilesystemActionRequest } from "./actionPlanner";
import { useLocalModelStore } from "@/store/localModelStore";

const OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
const LLM_TIMEOUT_MS = 3000; // Reduced from 8000 - planning JSON is small, no need to wait 8s

function getPreferredModel(): { endpoint: string; modelId: string } | null {
  try {
    const store = useLocalModelStore.getState();
    const enabled = store.models.filter(m => m.enabled);
    if (enabled.length > 0) {
      const m = enabled[0];
      const prov = store.providers.find(p => p.id === m.providerId);
      if (prov) return { endpoint: prov.endpoint, modelId: m.modelId };
      return { endpoint: "http://127.0.0.1:11434/v1", modelId: m.modelId };
    }
    // Fallback to known installed model
    return { endpoint: "http://127.0.0.1:11434/v1", modelId: "qwen2.5-coder:7b" };
  } catch {
    return { endpoint: "http://127.0.0.1:11434/v1", modelId: "qwen2.5-coder:7b" };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callOllamaForPlan(userText: string, contextStr: string, _chatId: string | null): Promise<string | null> {
  const pref = getPreferredModel();
  if (!pref) return null;
  const model = pref.modelId || "qwen2.5-coder:7b";

  // Try Ollama native /api/chat first (more reliable for qwen)
  const url = OLLAMA_CHAT_URL;
  const system = AGENT_SYSTEM_PROMPT;
  const userPrompt = `Context:\n${contextStr}\n\nUser request: "${userText}"\n\nRespond with ONLY JSON matching schema. No explanation outside JSON.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt }
        ],
        stream: false,
        options: { temperature: 0.2, num_predict: 300 }, // Reduced from 800 - planning JSON is small
        keep_alive: "5m"
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.debug(`[LLM Planner] Ollama error ${res.status}: ${err.slice(0,200)}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    const content = data?.message?.content || data?.response || "";
    if (!content) return null;
    return content;
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === "AbortError") console.debug(`[LLM Planner] timeout after ${LLM_TIMEOUT_MS}ms`);
    else console.debug(`[LLM Planner] fetch failed: ${e.message?.slice(0,120)}`);
    return null;
  }
}

function extractJson(text: string): string | null {
  // Find first { and last } to extract JSON
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Try to fix common issues: trailing commas, single quotes
    try {
      const fixed = candidate.replace(/'/g, '"').replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }
}

// Unused helper kept for future mapping
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _mapLLMActionToPlannedAction(llmAction: any): any | null {
  // Map LLM AgentAction to existing PlannedAction for executor compatibility
  if (!llmAction || typeof llmAction.type !== "string") return null;
  switch (llmAction.type) {
    case "createDirectory":
      return { kind: "createFolder", name: llmAction.path?.split(/[\\/]/).pop() || llmAction.path, clause: `LLM:${llmAction.path}`, basePath: llmAction.path.includes(":") ? llmAction.path.split(/[\\/]/).slice(0, -1).join("\\") || undefined : undefined, _rawPath: llmAction.path };
    case "createFile":
      return { kind: "createFile", name: llmAction.path?.split(/[\\/]/).pop() || "file.txt", clause: `LLM:${llmAction.path}`, content: llmAction.content || "", _rawPath: llmAction.path, folderRef: llmAction.path.includes("/") || llmAction.path.includes("\\") ? llmAction.path.split(/[\\/]/).slice(0, -1).join("/") || undefined : undefined };
    case "writeFile":
      return { kind: "writeFile", name: llmAction.path?.split(/[\\/]/).pop() || "file.txt", clause: `LLM:${llmAction.path}`, content: llmAction.content || "" };
    case "readFile":
      return { kind: "read", target: llmAction.path, clause: `LLM:${llmAction.path}` };
    case "delete":
      return { kind: "delete", target: llmAction.path, clause: `LLM:${llmAction.path}` };
    case "listDirectory":
      return { kind: "list", target: llmAction.path, clause: `LLM:${llmAction.path}` };
    case "move":
      // Move is not directly in PlannedAction, map to custom
      return { kind: "move", source: llmAction.source, destination: llmAction.destination, clause: `LLM:move` };
    case "copy":
      return { kind: "copy", source: llmAction.source, destination: llmAction.destination, clause: `LLM:copy` };
    case "runCommand":
      return { kind: "run", command: llmAction.command, clause: `LLM:run` };
    default:
      return null;
  }
}

// Convert LLM plan to internal representation that authorizedExecutor can understand
// We will create a new type that holds AgentPlan and also compatible PlannedAction[] for fallback executor

export async function planViaLLM(userText: string, chatId: string | null): Promise<{ plan: AgentPlan; via: "llm" } | null> {
  const ctx = buildAgentContext(chatId, userText);
  const ctxStr = formatContextForLLM(ctx, chatId);

  // Debug logging: REQUEST, INTENT, CONTEXT
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[Agent][REQUEST] "${userText}"`);
    console.debug(`[Agent][CONTEXT] ${ctxStr.slice(0, 800)}`);
  }

  const raw = await callOllamaForPlan(userText, ctxStr, chatId);
  if (!raw) {
    console.debug(`[Agent][LLM] no response, fallback to deterministic`);
    return null;
  }

  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    console.debug(`[Agent][LLM] failed to extract JSON from: ${raw.slice(0, 300)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr) as AgentPlan;
    // Basic shape validation
    if (!parsed.intent || !Array.isArray(parsed.actions)) {
      console.debug(`[Agent][LLM] invalid shape`, parsed);
      return null;
    }
    // Ensure actions have required fields
    for (const a of parsed.actions) {
      if (!a.type) return null;
    }

    if (process.env.NODE_ENV !== "production") {
      console.debug(`[Agent][LLM PLAN] intent=${parsed.intent} actions=${parsed.actions.length} explanation=${parsed.explanation || ""}`);
      console.debug(`[Agent][LLM PLAN JSON] ${jsonStr.slice(0, 800)}`);
    }

    return { plan: parsed, via: "llm" };
  } catch (e) {
    console.debug(`[Agent][LLM] JSON parse failed: ${(e as Error).message}`);
    return null;
  }
}

export function planViaDeterministic(userText: string, chatId: string | null): AgentPlan {
  const planned = deterministicPlan(userText, chatId || "default");
  // Map PlannedAction to AgentAction
  const actions: any[] = [];
  for (const p of planned) {
    switch (p.kind) {
      case "createFolder":
        if ((p as any).basePath) {
          const base = (p as any).basePath as string;
          const full = `${base.replace(/[\\/]+$/, "")}\\${p.name}`;
          actions.push({ type: "createDirectory", path: full });
        } else {
          actions.push({ type: "createDirectory", path: p.name });
        }
        break;
      case "createFile":
        {
          const filePath = (p as any).folderRef ? `${(p as any).folderRef}/${p.name}`.replace("//", "/") : p.name;
          // If folderRef is "it", resolve to actual path via context would be done later; keep as is and let validator/executor resolve
          const content = (p as any).content || "";
          // Special handling for folderRef "it" – keep path as file name, executor will resolve via executionContext
          if ((p as any).folderRef === "it") {
            // We need to preserve the intent: file inside previous folder
            // For now, push with path as file name, but add metadata for executor to resolve
            actions.push({ type: "createFile", path: p.name, content, _folderRef: "it" } as any);
          } else if ((p as any).folderRef) {
            actions.push({ type: "createFile", path: filePath, content });
          } else {
            actions.push({ type: "createFile", path: p.name, content });
          }
        }
        break;
      case "writeFile":
        actions.push({ type: "writeFile", path: p.name, content: p.content });
        break;
      case "read":
        actions.push({ type: "readFile", path: (p as any).target });
        break;
      case "delete":
        actions.push({ type: "delete", path: (p as any).target });
        break;
      case "list":
        actions.push({ type: "listDirectory", path: (p as any).target || "" });
        break;
      case "goTo":
        actions.push({ type: "readFile", path: (p as any).target });
        break;
      case "count":
        actions.push({ type: "listDirectory", path: (p as any).target || "" });
        break;
      default:
        break;
    }
  }

  // Determine intent from actions
  const intent = actions.length === 1 ? actions[0].type : actions.length > 1 ? "multi_step" : "clarification";

  return {
    intent,
    explanation: `Deterministic plan: ${actions.map(a => `${a.type} ${a.path || a.source || ""}`).join(", ")}`,
    actions,
  };
}

// Fast path: simple explicit requests don't need LLM (saves 3s)
// Refined: pronouns like "inside it" are resolvable deterministically when an explicit target (e.g. "kumar19") is present,
// so only block truly ambiguous pronouns without explicit target.
function isSimpleDeterministicRequest(text: string): boolean {
  const lower = text.toLowerCase();
  // Must be filesystem action with explicit target
  if (!isFilesystemActionRequest(text)) return false;
  if (!hasExplicitTarget(text)) return false;
  // Only block highly ambiguous patterns without clear target
  if (/\b(same name|another one|previous one|do the thing)\b/.test(lower)) return false;
  // Natural language variations that deterministic handles poorly need LLM
  if (/\b(mkdir|set up|give me a place|i need a new|can you make me)\b/.test(lower)) return false;
  return true;
}

// Unified entry: try LLM first, fallback to deterministic
export async function createAgentPlan(userText: string, chatId: string | null): Promise<{ plan: AgentPlan; via: "llm" | "deterministic" }> {
  // Fast deterministic routing for simple explicit requests (saves LLM call)
  if (isSimpleDeterministicRequest(userText)) {
    const det = planViaDeterministic(userText, chatId);
    if (det.actions.length > 0) {
      if (process.env.NODE_ENV !== "production") console.debug(`[Agent][FastPath] deterministic for "${userText.slice(0,40)}"`);
      return { plan: det, via: "deterministic" };
    }
  }
  // In tests (vitest), window may be defined but Ollama not reachable – we should fallback quickly
  // We try LLM but with short timeout; if fails, fallback
  const llmResult = await planViaLLM(userText, chatId);
  if (llmResult) {
    return llmResult;
  }
  const det = planViaDeterministic(userText, chatId);
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[Agent][Deterministic] fallback`, det);
  }
  return { plan: det, via: "deterministic" };
}
