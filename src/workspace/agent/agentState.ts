// Unified per-chat agent state machine – single source of truth for autonomous goals.
// Replaces competing deterministic vs LLM loops. Every filesystem/terminal action
// must flow through this state and be validated against authorized requested actions.

export type AgentStatus = "idle" | "planning" | "executing" | "waiting" | "completed" | "clarification_required" | "failed";

export type AuthorizedActionType = "create_folder" | "create_file" | "write_file" | "list" | "count" | "delete" | "goTo" | "read" | "run" | "move" | "copy";

export interface AuthorizedAction {
  id: string;
  type: AuthorizedActionType;
  target: string; // e.g., "shanu10", "shanu10/test.txt", "C:\Users\pilli\shanu10"
  rawClause: string;
  content?: string; // for write
  status: "pending" | "executing" | "completed" | "failed";
  result?: StructuredToolResult;
  basePath?: string; // explicit absolute base path when supplied in current message (e.g., C:\Users\pilli\Downloads)
  source?: string; // for move/copy
  destination?: string; // for move/copy
  command?: string; // for run
}

export interface StructuredToolResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  command: string;
  path?: string; // verified absolute path from tool stdout, not from command
  error?: string;
  durationMs?: number;
}

export interface AgentGoalState {
  chatId: string;
  goal: string; // original user request
  status: AgentStatus;
  requestedActions: AuthorizedAction[];
  completedActions: AuthorizedAction[];
  pendingActions: AuthorizedAction[];
  observations: StructuredToolResult[];
  cwd: string | null; // logical cwd per chat
  lastUserIntent: string;
  lastToolResult?: StructuredToolResult;
  createdAt: number;
  updatedAt: number;
  failureReason?: string;
}

const STORAGE_PREFIX = "nexuss_agent_state_";
const MAX_ACTIONS = 10;

function key(chatId: string): string {
  return `${STORAGE_PREFIX}${chatId}`;
}

function load(chatId: string): AgentGoalState | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(chatId));
    if (!raw) return null;
    return JSON.parse(raw) as AgentGoalState;
  } catch {
    return null;
  }
}

function save(state: AgentGoalState): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key(state.chatId), JSON.stringify(state));
  } catch {}
}

const memory: Record<string, AgentGoalState> = {};

export function getAgentState(chatId: string): AgentGoalState | null {
  if (memory[chatId]) return memory[chatId];
  const loaded = load(chatId);
  if (loaded) memory[chatId] = loaded;
  return memory[chatId] || null;
}

export function setAgentState(state: AgentGoalState): void {
  state.updatedAt = Date.now();
  memory[state.chatId] = state;
  save(state);
}

export function clearAgentState(chatId: string): void {
  delete memory[chatId];
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(key(chatId));
    } catch {}
  }
}

export function createGoalState(chatId: string, goal: string, cwd: string | null): AgentGoalState {
  const now = Date.now();
  const state: AgentGoalState = {
    chatId,
    goal,
    status: "planning",
    requestedActions: [],
    completedActions: [],
    pendingActions: [],
    observations: [],
    cwd,
    lastUserIntent: goal,
    createdAt: now,
    updatedAt: now,
  };
  setAgentState(state);
  return state;
}

export function updateGoalWithActions(chatId: string, actions: AuthorizedAction[]): AgentGoalState | null {
  const s = getAgentState(chatId);
  if (!s) return null;
  s.requestedActions = actions.slice(0, MAX_ACTIONS);
  s.pendingActions = [...s.requestedActions];
  s.status = actions.length > 0 ? "executing" : "completed";
  setAgentState(s);
  return s;
}

export function completeAction(chatId: string, actionId: string, result: StructuredToolResult): void {
  const s = getAgentState(chatId);
  if (!s) return;
  const idx = s.pendingActions.findIndex(a => a.id === actionId);
  if (idx >= 0) {
    const [act] = s.pendingActions.splice(idx, 1);
    act.status = result.success ? "completed" : "failed";
    act.result = result;
    if (result.success) s.completedActions.push(act);
    else s.pendingActions.splice(idx, 0, { ...act, status: "failed" as const, result });
    s.observations.push(result);
    s.lastToolResult = result;
    // Update cwd if this was a goTo that succeeded
    if (act.type === "goTo" && result.success && result.path) {
      s.cwd = result.path;
    } else if (result.path && result.success) {
      // For create, keep cwd as parent of created path? Not changing logical cwd, but we could
    }
    if (!result.success) s.status = "failed";
    else if (s.pendingActions.length === 0) s.status = "completed";
    else s.status = "executing";
    setAgentState(s);
  }
}

export function isGoalComplete(chatId: string): boolean {
  const s = getAgentState(chatId);
  if (!s) return true;
  return s.pendingActions.length === 0 && (s.status === "completed" || s.status === "failed" || s.status === "idle");
}

export function newActionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
