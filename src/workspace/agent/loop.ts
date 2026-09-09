// Production agent loop: Tool Results → Model
// Implements the while(agent has more work) loop that makes ONE user
// message sufficient for autonomous multi-step coding (discover → read → edit → run → fix → verify).

import { useWorkspaceStore } from "@/workspace/store";
import { extractChangeBlock, stripChangeBlock, extractCommandBlock, stripCommandBlock, hasCommandFence } from "./parse";
import { toolProposeUpsert, toolRead, toolList, toolSearch } from "./tools";
import type { ToolContext } from "./types";
import { contentHash } from "../indexer";

export const MAX_AGENT_STEPS = 6;

export interface LoopToolResult {
  kind: "change" | "command" | "read" | "list" | "search";
  path?: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  content?: string;
  error?: string;
}

export function hasAnyFence(text: string): boolean {
  return !!extractChangeBlock(text) || !!extractCommandBlock(text) || hasCommandFence(text);
}

export function stripAllFences(text: string): string {
  let out = stripChangeBlock(text);
  out = stripCommandBlock(out);
  // If any fence remained invalid, strip again to avoid leaking JSON
  if (out.includes("workspace-change") || out.includes("workspace-command")) {
    out = out.replace(/```workspace-(change|command)[\s\S]*?```/gi, "").trim();
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function formatToolResults(results: LoopToolResult[]): string {
  if (results.length === 0) return "";
  const lines: string[] = ["## Tool results (previous step)"];
  for (const r of results) {
    if (r.kind === "change") {
      lines.push(`- ${r.path}: ${r.success ? "applied" : `failed ${r.error}`}`);
      if (r.content) lines.push(`  content preview: ${r.content.slice(0, 400)}`);
    } else if (r.kind === "command") {
      lines.push(`- command ${r.path}: exit ${r.exitCode ?? "n/a"} ${r.success ? "success" : "failed"}`);
      if (r.stdout) lines.push(`  stdout: ${r.stdout.slice(0, 800)}`);
      if (r.stderr) lines.push(`  stderr: ${r.stderr.slice(0, 800)}`);
      if (r.error) lines.push(`  error: ${r.error}`);
    } else {
      lines.push(`- ${r.kind} ${r.path ?? ""}: ${r.success ? (r.content ?? "").slice(0,800) : r.error}`);
    }
  }
  return lines.join("\n");
}

export function getToolContext(): ToolContext {
  const s = useWorkspaceStore.getState();
  return {
    connected: s.connected,
    pathEnabled: s.pathEnabled,
    bridge: s.bridge as unknown as ToolContext["bridge"],
    index: s.index,
    runtime: s.runtime as unknown as ToolContext["runtime"]
  };
}

/**
 * Execute fenced blocks found in `modelText` and return tool results.
 * Auto-applies writes when workspace is in-memory/demo (test) or when
 * the change is safe; otherwise stages via proposeChangeFromBlock and
 * signals that approval is required (loop pauses).
 */
export async function executeFencedTools(modelText: string): Promise<{ results: LoopToolResult[]; needsApproval: boolean; stripped: string }> {
  const s = useWorkspaceStore.getState();
  const changeBlock = extractChangeBlock(modelText);
  const commandBlock = extractCommandBlock(modelText);
  const stripped = stripAllFences(modelText);
  const results: LoopToolResult[] = [];
  let needsApproval = false;

  // TERMINAL != FILESYSTEM: terminal (workspace-command) does not require pathEnabled/connected
  // Filesystem changes (workspace-change) still require pathEnabled
  const canChange = s.pathEnabled;
  const canCommand = true; // terminal available immediately when panel open

  // Auto-apply: changes require in-memory demo, commands auto-apply when Terminal panel is open
  const autoApplyChange = s.agentAutoLoop && s.workspace?.kind === "in-memory";
  const autoApplyCommand = s.panelOpen;

  if (changeBlock) {
    if (!canChange) {
      for (const op of changeBlock.changes) {
        results.push({ kind: "change", path: op.path, success: false, error: "Terminal is not connected — connect workspace to use terminal tools." });
      }
    } else {
      for (const op of changeBlock.changes) {
        try {
          if (autoApplyChange) {
            // Direct apply without staging (in-memory auto-apply)
            const ctx = getToolContext();
            await toolProposeUpsert(ctx, op.path, op.content);
            const { assertInsideRoot } = await import("../path");
            assertInsideRoot("", op.path);
            try {
              await s.bridge!.create(op.path, op.content);
            } catch {
              await s.bridge!.write(op.path, op.content);
            }
            await s.refresh().catch(() => {});
            results.push({ kind: "change", path: op.path, success: true, content: op.content });
          } else {
            // Stage for approval - loop must pause
            await s.proposeChangeFromBlock([op]);
            results.push({ kind: "change", path: op.path, success: true, content: "staged for approval" });
            needsApproval = true;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ kind: "change", path: op.path, success: false, error: msg });
        }
      }
    }
  }

  if (commandBlock) {
    if (autoApplyCommand) {
      const ctx = getToolContext();
      if (commandBlock.run) {
        try {
          const { toolRun } = await import("./tools");
          const r = await toolRun(ctx, commandBlock.run.command, commandBlock.run.cwd ? { cwd: commandBlock.run.cwd } : undefined);
          results.push({ kind: "command", path: commandBlock.run.command, success: r.success, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
        } catch (e) {
          results.push({ kind: "command", path: commandBlock.run.command, success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (commandBlock.test) {
        try {
          const { toolTest } = await import("./tools");
          const r = await toolTest(ctx, commandBlock.test.cwd ? { cwd: commandBlock.test.cwd } : undefined);
          results.push({ kind: "command", path: r.command, success: r.success, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
        } catch (e) {
          results.push({ kind: "command", success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } else {
      await s.proposeCommandFromBlock(commandBlock);
      needsApproval = true;
      results.push({ kind: "command", success: true, stdout: "staged for approval" });
    }
  }

  return { results, needsApproval, stripped };
}
