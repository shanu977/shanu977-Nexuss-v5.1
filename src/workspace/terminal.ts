// Robust non-tool fallback for phi3 and other models without native tool calling.
// Format: <terminal>COMMAND</terminal> — simple, deterministic, easy for small models.
// Existing workspace-command fences remain fully supported for Qwen.

export const TERMINAL_TAG = "terminal";
const TERMINAL_RE = /<terminal>\s*([\s\S]*?)\s*<\/terminal>/i;

export interface TerminalTag {
  command: string;
}

export function extractTerminalTag(content: string): TerminalTag | null {
  const m = TERMINAL_RE.exec(content);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  if (raw.length > 2000) return null;
  // Basic validation: must be non-empty command, no null bytes
  if (raw.includes("\0")) return null;
  return { command: raw };
}

export function hasTerminalTag(content: string): boolean {
  return TERMINAL_RE.test(content);
}

export function stripTerminalTag(content: string): string {
  return content.replace(TERMINAL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Helper to detect any terminal-like fence for loop control
export function hasAnyTerminalFence(content: string): boolean {
  return hasTerminalTag(content);
}
