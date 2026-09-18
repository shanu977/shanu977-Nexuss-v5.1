import { getRecentExecutionContext, formatExecutionContextForPrompt } from "./executionContext";
import { useWorkspaceStore } from "@/workspace/store";
import type { AgentContext } from "./llmTypes";

export function buildAgentContext(chatId: string | null, userText?: string): AgentContext {
  const store = useWorkspaceStore.getState();
  const recent = getRecentExecutionContext(chatId).filter(e => e.success && e.verified).slice(-5);

  const recentEntities = recent.map(e => ({
    type: (e.object === "file" ? "file" : e.object === "folder" || e.object === "directory" ? "directory" : "path") as "file" | "directory" | "path",
    name: e.name,
    absolutePath: e.path,
    relativePath: e.path ? e.path.split("\\").pop() : undefined,
    verified: e.verified,
  }));

  // Also include recent actions/results for loop adaptation
  const recentActions = recent.map(e => `${e.action || "run"} ${e.object || ""} ${e.name || ""} -> ${e.path || e.cwd} (${e.success ? "success" : "failed"})`);
  const recentResults = recent.map(e => ({ success: e.success, path: e.path, stdout: e.stdout.slice(0, 200) }));

  const workspaceRoot = store.workspacePath || store.workspace?.root || undefined;
  const workspaceKind = store.workspace?.kind;

  // Build compact history summary for pronoun resolution (last 2 actions)
  const historySummary = recent.length > 0
    ? `Recent verified entities: ${recent.map(e => `${e.object || "item"} "${e.name || e.path}" at ${e.path || e.cwd}`).join("; ")}`
    : undefined;

  return {
    workspaceRoot,
    workspaceKind,
    recentEntities,
    recentActions,
    recentResults,
    historySummary,
  };
}

export function formatContextForLLM(ctx: AgentContext, chatId: string | null): string {
  const parts: string[] = [];
  if (ctx.workspaceRoot) parts.push(`Workspace root: ${ctx.workspaceRoot} (kind: ${ctx.workspaceKind || "unknown"})`);
  else parts.push(`Workspace: not connected (outside-workspace operations may be blocked by policy)`);

  if (ctx.recentEntities && ctx.recentEntities.length > 0) {
    parts.push(`Recent verified entities (use to resolve "same name", "that folder", "it", "there"):`);
    for (const e of ctx.recentEntities) {
      parts.push(`- ${e.type} name="${e.name || "?"}" absolutePath="${e.absolutePath || "?"}" verified=${e.verified}`);
    }
  } else {
    parts.push(`No recent verified entities.`);
  }

  // Also include formatted execution context (existing helper) for richer info
  const execPrompt = formatExecutionContextForPrompt(chatId);
  if (execPrompt) parts.push(execPrompt);

  return parts.join("\n");
}
