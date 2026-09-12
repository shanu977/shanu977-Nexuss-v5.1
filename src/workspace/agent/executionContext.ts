// Persistent structured execution context for continuous agent behavior.
// Stores recent successful terminal actions so follow-up pronouns ("it", "that folder")
// can be resolved without asking for already-available context.
// Survives streaming, second model turn, and subsequent user messages.
// Persists to localStorage so it survives chat reload when architecture supports it.

export interface ExecutionContextEntry {
  id: string;
  timestamp: number;
  userText: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  // Semantic hints parsed from command (best-effort, not authoritative)
  action?: "create" | "delete" | "list" | "read" | "run";
  object?: "folder" | "file" | "directory";
  name?: string;
  path?: string; // resolved absolute-ish path when determinable
}

const STORAGE_KEY = "nexuss_exec_context";
const MAX_HISTORY = 8;

function load(): ExecutionContextEntry[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function save(entries: ExecutionContextEntry[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_HISTORY)));
  } catch {}
}

let memory: ExecutionContextEntry[] = load();

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSemantic(command: string, cwd: string): Partial<Pick<ExecutionContextEntry, "action" | "object" | "name" | "path">> {
  const lower = command.toLowerCase();
  // mkdir / New-Item Directory
  // covers: mkdir shanu, mkdir -p shanu/project, powershell New-Item -ItemType Directory -Path 'shanu'
  const mkdirMatch = command.match(/(?:mkdir|md)\s+["']?([^\s"']+)/i);
  const newItemDirMatch = command.match(/New-Item[^;]*-ItemType\s+Directory[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/New-Item[^;]*-Path\s+["']([^"']+)["'][^;]*-ItemType\s+Directory/i);
  const newItemFileMatch = command.match(/New-Item[^;]*-ItemType\s+File[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/New-Item[^;]*-Path\s+["']([^"']+)["'][^;]*-ItemType\s+File/i) || command.match(/ni\s+["']?([^\s"']+)/i);
  const rmMatch = command.match(/Remove-Item[^;]*-LiteralPath\s+["']([^"']+)["']/i) || command.match(/Remove-Item[^;]*-Path\s+["']([^"']+)["']/i) || command.match(/(?:Remove-Item|rm|del|rmdir)\s+["']?([^\s"']+)/i);
  const gciMatch = command.match(/Get-ChildItem\s+.*-LiteralPath\s+["']([^"']+)["']/i) || command.match(/Get-ChildItem\s+.*-Path\s+["']([^"']+)["']/i);

  if (mkdirMatch) {
    const name = mkdirMatch[1].replace(/^[.\/\\]+/, "");
    const base = name.split(/[\\/]/).pop() || name;
    const full = cwd ? `${cwd.replace(/\\/g, "/")}/${name.replace(/\\/g, "/")}` : name;
    return { action: "create", object: "folder", name: base, path: full };
  }
  if (newItemDirMatch) {
    const p = newItemDirMatch[1];
    const base = p.split(/[\\/]/).pop() || p;
    const full = p.includes(":") || p.startsWith("/") ? p : cwd ? `${cwd.replace(/\\/g, "/")}/${p.replace(/\\/g, "/")}` : p;
    return { action: "create", object: "folder", name: base, path: full };
  }
  if (newItemFileMatch) {
    const p = newItemFileMatch[1];
    const base = p.split(/[\\/]/).pop() || p;
    const full = p.includes(":") || p.startsWith("/") ? p : cwd ? `${cwd.replace(/\\/g, "/")}/${p.replace(/\\/g, "/")}` : p;
    return { action: "create", object: "file", name: base, path: full };
  }
  if (rmMatch) {
    const p = rmMatch[1];
    const base = p.split(/[\\/]/).pop() || p;
    return { action: "delete", object: "folder", name: base, path: p };
  }
  if (gciMatch) {
    const p = gciMatch[1];
    return { action: "list", object: "folder", name: p.split(/[\\/]/).pop() || p, path: p };
  }
  if (lower.includes("get-childitem")) return { action: "list", object: "folder" };
  if (lower.includes("node --version") || lower.includes("npm --version")) return { action: "run", object: "file" };
  return {};
}

export function pushExecutionContext(entry: Omit<ExecutionContextEntry, "id" | "timestamp">): ExecutionContextEntry {
  const full: ExecutionContextEntry = {
    id: newId(),
    timestamp: Date.now(),
    ...entry,
    ...parseSemantic(entry.command, entry.cwd),
  };
  // Only keep successful or recent failures? Keep both but successful are primary for pronoun resolution
  memory = [...memory, full].slice(-MAX_HISTORY);
  save(memory);
  return full;
}

export function getRecentExecutionContext(): ExecutionContextEntry[] {
  // Refresh from storage if empty (e.g., after reload)
  if (memory.length === 0) memory = load();
  return [...memory];
}

export function formatExecutionContextForPrompt(): string | null {
  const recent = getRecentExecutionContext().filter((e) => e.success).slice(-4);
  if (recent.length === 0) return null;
  const lines: string[] = ["## Recent execution context (last successful terminal actions) — use this to resolve pronouns like 'it', 'that folder', 'there' without asking for clarification:"];
  for (const e of recent.slice().reverse()) {
    const namePart = e.name ? ` name="${e.name}"` : "";
    const pathPart = e.path ? ` path="${e.path}"` : e.cwd ? ` cwd="${e.cwd}"` : "";
    const stdoutPart = e.stdout ? ` stdout="${e.stdout.slice(0, 400).replace(/\n/g, " ")}"` : " stdout=(empty)";
    const actionPart = e.action ? ` action=${e.action}` : "";
    const objectPart = e.object ? ` object=${e.object}` : "";
    lines.push(`- [${new Date(e.timestamp).toLocaleTimeString()}] command="${e.command}"${actionPart}${objectPart}${namePart}${pathPart} success=${e.success}${stdoutPart} stderr="${e.stderr.slice(0, 200).replace(/\n/g, " ")}"`);
  }
  lines.push("If user says \"it\"/\"that folder\"/\"there\", resolve to the most recent relevant entry above. If that entry failed, do not assume object exists. If no relevant entry, inspect filesystem via terminal rather than hallucinate.");
  return lines.join("\n");
}

export function clearExecutionContext(): void {
  memory = [];
  save(memory);
}
