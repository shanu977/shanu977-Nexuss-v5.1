// Persistent structured execution context for continuous agent behavior.
// Stores recent successful terminal actions so follow-up pronouns ("it", "that folder")
// can be resolved without asking for already-available context.
// Survives streaming, second model turn, and subsequent user messages.
// Persists to localStorage per-chat (chatId-scoped) so it survives reload and
// does NOT leak between unrelated conversations.

export interface ExecutionContextEntry {
  id: string;
  timestamp: number;
  chatId?: string | null;
  userText: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  action?: "create" | "delete" | "list" | "read" | "run";
  object?: "folder" | "file" | "directory";
  name?: string;
  path?: string;
  verified: boolean; // true only when backed by real terminal tool result
}

const STORAGE_PREFIX = "nexuss_exec_context_";
const LEGACY_KEY = "nexuss_exec_context";
const MAX_HISTORY = 8;

function storageKey(chatId: string | null | undefined): string {
  return chatId ? `${STORAGE_PREFIX}${chatId}` : LEGACY_KEY;
}

function loadForChat(chatId: string | null | undefined): ExecutionContextEntry[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(chatId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(-MAX_HISTORY);
    }
    return [];
  } catch {
    return [];
  }
}

function saveForChat(chatId: string | null | undefined, entries: ExecutionContextEntry[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(chatId), JSON.stringify(entries.slice(-MAX_HISTORY)));
  } catch {}
}

// In-memory cache per chatId
const memoryByChat: Record<string, ExecutionContextEntry[]> = {};

function getMemory(chatId: string | null | undefined): ExecutionContextEntry[] {
  const key = chatId || "__global__";
  if (!memoryByChat[key]) {
    memoryByChat[key] = loadForChat(chatId);
  }
  return memoryByChat[key];
}

function setMemory(chatId: string | null | undefined, entries: ExecutionContextEntry[]): void {
  const key = chatId || "__global__";
  memoryByChat[key] = entries.slice(-MAX_HISTORY);
  saveForChat(chatId, memoryByChat[key]);
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSemantic(command: string, cwd: string): Partial<Pick<ExecutionContextEntry, "action" | "object" | "name" | "path">> {
  const lower = command.toLowerCase();
  const mkdirMatch = command.match(/(?:mkdir|md)\s+["']?([^\s"']+)/i);
  const newItemDirMatch = command.match(/New-Item[^;]*-ItemType\s+Directory[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/New-Item[^;]*-Path\s+["']([^"']+)["'][^;]*-ItemType\s+Directory/i);
  const newItemFileMatch = command.match(/New-Item[^;]*-ItemType\s+File[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/New-Item[^;]*-Path\s+["']([^"']+)["'][^;]*-ItemType\s+File/i) || command.match(/ni\s+["']?([^\s"']+)/i);
  const setContentMatch = command.match(/Set-Content[^;]*-Path\s+["']([^"']+)["']/i);
  const rmMatch = command.match(/Remove-Item[^;]*-LiteralPath\s+["']([^"']+)["']/i) || command.match(/Remove-Item[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/(?:Remove-Item|rm|del|rmdir)\s+["']?([^\s"']+)/i);
  const gciMatch = command.match(/Get-ChildItem\s+.*-LiteralPath\s+["']([^"']+)["']/i) || command.match(/Get-ChildItem\s+.*-Path\s+["']([^"']+)["']/i);

  const clean = (p: string) => p.replace(/^[.\/\\]+/, "").replace(/\\/g, "/");
  const resolve = (p: string) => {
    const c = clean(p);
    if (p.includes(":") || p.startsWith("/") || p.startsWith("\\")) return p;
    return cwd ? `${cwd.replace(/\\/g, "/")}/${c}` : c;
  };

  if (mkdirMatch) {
    const name = clean(mkdirMatch[1]);
    const base = name.split("/").pop() || name;
    return { action: "create", object: "folder", name: base, path: resolve(mkdirMatch[1]) };
  }
  if (newItemDirMatch) {
    const p = newItemDirMatch[1];
    const base = clean(p).split("/").pop() || clean(p);
    return { action: "create", object: "folder", name: base, path: resolve(p) };
  }
  if (newItemFileMatch) {
    const p = newItemFileMatch[1];
    const base = clean(p).split("/").pop() || clean(p);
    return { action: "create", object: "file", name: base, path: resolve(p) };
  }
  if (setContentMatch) {
    const p = setContentMatch[1];
    const base = clean(p).split("/").pop() || clean(p);
    return { action: "create", object: "file", name: base, path: resolve(p) };
  }
  if (rmMatch) {
    const p = rmMatch[1];
    const base = clean(p).split("/").pop() || clean(p);
    return { action: "delete", object: "folder", name: base, path: p };
  }
  if (gciMatch) {
    const p = gciMatch[1];
    const base = clean(p).split("/").pop() || clean(p);
    return { action: "list", object: "folder", name: base, path: resolve(p) };
  }
  if (lower.includes("get-childitem")) return { action: "list", object: "folder" };
  if (lower.includes("node --version") || lower.includes("npm --version")) return { action: "run", object: "file" };
  return {};
}

// Push with chatId scoping. Overload supports legacy (no chatId) for backwards compat.
// Only verified=true entries are considered evidence of filesystem state.
export function pushExecutionContext(entry: Omit<ExecutionContextEntry, "id" | "timestamp" | "verified"> & { chatId?: string | null; verified?: boolean }): ExecutionContextEntry;
export function pushExecutionContext(chatId: string | null | undefined, entry: Omit<ExecutionContextEntry, "id" | "timestamp" | "chatId" | "verified"> & { verified?: boolean }): ExecutionContextEntry;
export function pushExecutionContext(a: any, b?: any): ExecutionContextEntry {
  let chatId: string | null | undefined;
  let entry: any;
  if (b !== undefined) {
    chatId = a;
    entry = b;
  } else {
    chatId = a?.chatId ?? null;
    entry = a;
  }
  const semantic = parseSemantic(entry.command, entry.cwd);
  // If caller provided explicit semantic, it overrides inferred; verified path takes precedence over inferred
  const explicitPath = entry.path;
  const explicitAction = entry.action;
  const explicitObject = entry.object;
  const explicitName = entry.name;
  const full: ExecutionContextEntry = {
    id: newId(),
    timestamp: Date.now(),
    chatId: chatId ?? entry.chatId ?? null,
    ...entry,
    ...semantic,
    // caller-provided verified fields override inferred
    ...(explicitAction ? { action: explicitAction } : {}),
    ...(explicitObject ? { object: explicitObject } : {}),
    ...(explicitName ? { name: explicitName } : {}),
    ...(explicitPath ? { path: explicitPath } : {}),
    verified: entry.verified !== false, // default true when pushed from real tool
  };
  // Enforce: if not verified, do not treat as filesystem evidence (still stored but marked)
  const mem = getMemory(chatId);
  const next = [...mem, full].slice(-MAX_HISTORY);
  setMemory(chatId, next);
  return full;
}

export function pushVerifiedObservation(
  chatId: string,
  base: Omit<ExecutionContextEntry, "id" | "timestamp" | "verified" | "chatId"> & { verifiedPath?: string }
): ExecutionContextEntry {
  const verifiedPath = (base as any).verifiedPath as string | undefined;
  const entry: any = { ...base, verified: true };
  if (verifiedPath) entry.path = verifiedPath;
  return pushExecutionContext(chatId, entry);
}

export function getRecentExecutionContext(chatId?: string | null): ExecutionContextEntry[] {
  if (chatId !== undefined && chatId !== null) {
    return [...getMemory(chatId)];
  }
  // If no chatId provided, try current chat-aware? return global
  return [...getMemory(null)];
}

export function formatExecutionContextForPrompt(chatId?: string | null): string | null {
  const recent = getRecentExecutionContext(chatId).filter((e) => e.success && e.verified).slice(-4);
  if (recent.length === 0) return null;
  return formatEntries(recent);
}

function formatEntries(recent: ExecutionContextEntry[]): string {
  const lines: string[] = ["## Recent execution context (last successful terminal actions) — use this to resolve pronouns like 'it', 'that folder', 'there' without asking for clarification:"];
  for (const e of recent.slice().reverse()) {
    const namePart = e.name ? ` name="${e.name}"` : "";
    const pathPart = e.path ? ` path="${e.path}"` : e.cwd ? ` cwd="${e.cwd}"` : "";
    const stdoutPart = e.stdout ? ` stdout="${e.stdout.slice(0, 400).replace(/\n/g, " ")}"` : " stdout=(empty)";
    const actionPart = e.action ? ` action=${e.action}` : "";
    const objectPart = e.object ? ` object=${e.object}` : "";
    lines.push(`- [${new Date(e.timestamp).toLocaleTimeString()}] chatId="${e.chatId || "global"}" command="${e.command}"${actionPart}${objectPart}${namePart}${pathPart} success=${e.success}${stdoutPart} stderr="${e.stderr.slice(0, 200).replace(/\n/g, " ")}"`);
  }
  lines.push("If user says \"it\"/\"that folder\"/\"there\", resolve to the most recent relevant entry above. If that entry failed, do not assume object exists. If no relevant entry, inspect filesystem via terminal rather than hallucinate.");
  return lines.join("\n");
}

export function clearExecutionContext(chatId?: string | null): void {
  if (chatId) {
    setMemory(chatId, []);
  } else {
    // Clear all
    for (const k of Object.keys(memoryByChat)) setMemory(k, []);
    saveForChat(null, []);
    try {
      if (typeof localStorage !== "undefined") {
        // Clear legacy
        localStorage.removeItem(LEGACY_KEY);
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
        }
      }
    } catch {}
  }
}

export function clearExecutionContextForChat(chatId: string): void {
  setMemory(chatId, []);
}
