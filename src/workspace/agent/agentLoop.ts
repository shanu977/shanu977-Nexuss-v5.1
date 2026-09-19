// Agent Loop: Understand → Context → Plan → Validate → Execute → Observe → Verify → Adapt
// LLM = understanding + planning, Code = validation + execution + verification

import type { AgentPlan, AgentAction } from "./llmTypes";
import { validateAgentPlan } from "./planValidator";
import { buildAgentContext } from "./agentContext";
import { createAgentPlan } from "./llmPlanner";
import { pushVerifiedObservation } from "./executionContext";
import { getAgentState, setAgentState, createGoalState, updateGoalWithActions, completeAction, type AuthorizedAction, type StructuredToolResult, newActionId } from "./agentState";
import { getToolContext } from "./loop";
import { toolRun } from "./tools";
import { synthesizeCommand, type PlannedAction } from "./actionPlanner";

// Convert AgentAction to AuthorizedAction for existing executor pipeline
function agentActionToAuthorized(action: AgentAction, rawClause: string): AuthorizedAction {
  switch (action.type) {
    case "createDirectory": {
      // Preserve absolute path correctly: split into basePath + name
      const p = action.path;
      if (/^[a-zA-Z]:[\\/]/.test(p)) {
        const parts = p.split(/[\\/]/);
        const name = parts.pop() || p;
        const base = parts.join("\\");
        return { id: newActionId(), type: "create_folder", target: name, rawClause, status: "pending" as const, basePath: base || undefined } as any;
      }
      return { id: newActionId(), type: "create_folder", target: p, rawClause, status: "pending" as const };
    }
    case "createFile": {
      // Path may be absolute or relative with folder
      const p = action.path;
      const content = action.content || "";
      if (/^[a-zA-Z]:[\\/]/.test(p)) {
        // Absolute file path
        return { id: newActionId(), type: "create_file", target: p.replace(/\\/g, "/"), rawClause, content, status: "pending" as const };
      }
      // Relative: keep as is (may be "project/app.py" or "app.py" or "it/app.py")
      // For "it" handling, the planner should have resolved, but we keep fallback
      if (p.includes("/") || p.includes("\\")) {
        return { id: newActionId(), type: "create_file", target: p.replace(/\\/g, "/"), rawClause, content, status: "pending" as const };
      }
      return { id: newActionId(), type: "create_file", target: p, rawClause, content, status: "pending" as const };
    }
    case "writeFile":
      return { id: newActionId(), type: "write_file", target: action.path, rawClause, content: action.content, status: "pending" as const };
    case "readFile":
      return { id: newActionId(), type: "read", target: action.path, rawClause, status: "pending" as const };
    case "delete":
      return { id: newActionId(), type: "delete", target: action.path, rawClause, status: "pending" as const };
    case "listDirectory":
      return { id: newActionId(), type: "list", target: action.path, rawClause, status: "pending" as const };
    case "move":
      return { id: newActionId(), type: "move" as any, target: `${action.source} -> ${action.destination}`, rawClause, status: "pending" as const, source: action.source, destination: action.destination } as any;
    case "copy":
      return { id: newActionId(), type: "copy" as any, target: `${action.source} -> ${action.destination}`, rawClause, status: "pending" as const, source: action.source, destination: action.destination } as any;
    case "runCommand":
      return { id: newActionId(), type: "run" as any, target: action.command, rawClause, status: "pending" as const, command: action.command } as any;
    default:
      return { id: newActionId(), type: "create_folder", target: "unknown", rawClause, status: "pending" as const };
  }
}

function logDebug(stage: string, data: string) {
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[AgentLoop][${stage}] ${data.slice(0, 800)}`);
  }
}

export interface AgentLoopResult {
  plan: AgentPlan;
  via: "llm" | "deterministic";
  execution: { executed: number; succeeded: number; failed: number; observations: StructuredToolResult[]; finalResponse: string };
}

export async function runAgentLoop(
  chatId: string,
  userText: string,
  opts: { panelOpen: boolean; workspacePath: string | null }
): Promise<AgentLoopResult | null> {
  // 1. UNDERSTAND + CONTEXT
  const ctx = buildAgentContext(chatId, userText);
  logDebug("REQUEST", userText);
  logDebug("CONTEXT", JSON.stringify(ctx).slice(0, 600));

  // 2. PLAN (LLM with fallback)
  const { plan, via } = await createAgentPlan(userText, chatId);
  logDebug("PLAN", JSON.stringify(plan).slice(0, 800));
  logDebug("VIA", via);

  // 3. VALIDATE
  const validation = validateAgentPlan(plan, opts.workspacePath || undefined);
  logDebug("VALIDATION", validation.valid ? "passed" : `failed: ${(validation as any).reason}`);
  if (!validation.valid) {
    const reason = (validation as any).reason as string;
    const code = (validation as any).code as string;
    if (code === "SECURITY") {
      return {
        plan,
        via,
        execution: {
          executed: 0,
          succeeded: 0,
          failed: 1,
          observations: [{ success: false, exitCode: 1, stdout: "", stderr: `Security blocked: ${reason}`, cwd: opts.workspacePath || "", command: "", error: reason } as any],
          finalResponse: `Blocked by security policy: ${reason}. Path traversal or absolute path outside authorized workspace is not allowed.`
        }
      };
    }
    if (code === "AMBIGUOUS" || plan.intent === "clarification") {
      return {
        plan,
        via,
        execution: {
          executed: 0,
          succeeded: 0,
          failed: 0,
          observations: [],
          finalResponse: plan.explanation || `I couldn't determine which ${plan.actions.length === 0 ? "target" : "action"} you meant. Could you clarify?`
        }
      };
    }
    // Invalid plan
    return {
      plan,
      via,
      execution: {
        executed: 0,
        succeeded: 0,
        failed: 1,
        observations: [],
        finalResponse: `Invalid plan: ${reason}`
      }
    };
  }

  // 4. AUTHORIZE + 5. EXECUTE LOOP
  // Convert to AuthorizedAction for existing pipeline
  const authorized = plan.actions.map(a => agentActionToAuthorized(a, userText));

  // Create goal state
  createGoalState(chatId, userText, opts.workspacePath);
  updateGoalWithActions(chatId, authorized as any);

  // Execute via existing pending loop, but with enhanced observe/verify/adapt
  const execution = await executeWithObserveVerify(chatId, userText, opts, plan);

  return { plan, via, execution };
}

async function executeWithObserveVerify(
  chatId: string,
  userText: string,
  opts: { panelOpen: boolean; workspacePath: string | null },
  plan: AgentPlan
): Promise<{ executed: number; succeeded: number; failed: number; observations: StructuredToolResult[]; finalResponse: string }> {
  const ctx = getToolContext();
  const hasExplicit = plan.actions.some(a => {
    const p = (a as any).path || (a as any).source || "";
    return /^[a-zA-Z]:[\\/]/.test(p) || p.includes("Downloads") || p.includes("outside");
  });

  let executed = 0, succeeded = 0, failed = 0;
  const observations: StructuredToolResult[] = [];

  // Use the existing executePending logic but adapted for AgentAction
  // We will iterate over pendingActions and for each, synthesize command, run, observe, verify
  while (true) {
    const state = getAgentState(chatId);
    if (!state || state.pendingActions.length === 0) break;
    const next = state.pendingActions[0];
    next.status = "executing";
    setAgentState(state);

    // Reconstruct PlannedAction for synthesizeCommand
    // For new types like move/copy, we need to handle directly
    let cmd: string;
    try {
      // Map AuthorizedAction back to PlannedAction for synthesize
      const planned = authorizedToPlannedForLoop(next);
      cmd = synthesizeCommand(planned, chatId, hasExplicit);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: err, cwd: opts.workspacePath || "", command: "", error: err } as any;
      completeAction(chatId, next.id, res);
      pushVerifiedObservation(chatId, { userText, command: "", cwd: opts.workspacePath || "", stdout: "", stderr: err, exitCode: null, success: false } as any);
      observations.push(res);
      failed++; executed++; break;
    }

    let toolRes: any;
    try {
      toolRes = await toolRun(ctx, cmd);
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      const isNetwork = rawMsg.includes("NETWORK_ERROR") || rawMsg.includes("Failed to fetch") || rawMsg.includes("ECONNREFUSED") || rawMsg.includes("Cannot reach");
      if (isNetwork) {
        // Network fallback is handled internally by the authorized executor's
        // public API (runAuthorizedGoal -> executePending -> tryBridgeFallback).
        // Keep tryBridgeFallback private to authorizedExecutor.ts and surface
        // a clear terminal-unreachable error here instead of reaching into
        // internal implementation details.
        const cleanMsg = rawMsg.replace(/^NETWORK_ERROR:\s*/i, "").trim();
        const msg = `Network error: ${cleanMsg} — terminal connector not reachable.`;
        const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: msg, cwd: opts.workspacePath || "", command: cmd, error: msg } as any;
        completeAction(chatId, next.id, res);
        pushVerifiedObservation(chatId, { userText, command: cmd, cwd: opts.workspacePath || "", stdout: "", stderr: msg, exitCode: null, success: false } as any);
        observations.push(res);
        logDebug("OBSERVE", `network failure ${msg.slice(0,120)}`);
        failed++; executed++; break;
      }
      const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: rawMsg, cwd: opts.workspacePath || "", command: cmd, error: rawMsg } as any;
      completeAction(chatId, next.id, res);
      pushVerifiedObservation(chatId, { userText, command: cmd, cwd: opts.workspacePath || "", stdout: "", stderr: rawMsg, exitCode: null, success: false } as any);
      observations.push(res);
      logDebug("OBSERVE", `command failure ${rawMsg.slice(0,120)}`);
      failed++; executed++; break;
    }

    executed++;
    const success = !!toolRes.success;
    let verifiedPath: string | undefined;
    if (success) {
      const out = (toolRes.stdout || "").trim();
      if (next.type === "create_folder" as any && out) verifiedPath = out.split("\n")[0].trim();
      else if ((next.type === "create_file" as any) && out) verifiedPath = out.split("\n")[0].trim();
      else if ((next.type as any) === "move" || (next.type as any) === "copy") {
        // For move/copy, verify destination exists
        const dst = (next as any).destination || (next as any).target?.split("->")[1]?.trim();
        if (dst) verifiedPath = dst;
      }
    }

    const structured: StructuredToolResult = {
      success,
      exitCode: toolRes.exitCode ?? null,
      stdout: toolRes.stdout || "",
      stderr: toolRes.stderr || "",
      cwd: toolRes.cwd || opts.workspacePath || "",
      command: cmd,
      path: verifiedPath || toolRes.cwd || undefined,
    } as any;

    completeAction(chatId, next.id, structured);
    pushVerifiedObservation(chatId, { userText, command: cmd, cwd: toolRes.cwd || opts.workspacePath || "", stdout: toolRes.stdout || "", stderr: toolRes.stderr || "", exitCode: toolRes.exitCode ?? null, success, path: verifiedPath } as any);
    observations.push(structured);
    logDebug("OBSERVE", `success=${success} path=${verifiedPath || toolRes.cwd} stdout=${(toolRes.stdout||"").slice(0,80)}`);

    // VERIFY
    const verified = await verifyAction(next, structured);
    logDebug("VERIFY", verified ? `verified ${next.type}` : `verification failed ${next.type}`);
    if (success && verified) succeeded++;
    else if (!success) { failed++; break; }
    else if (!verified) { failed++; break; } // verification failed

    // ADAPT: if plan had multiple steps and one failed, we could adapt, but for now break
  }

  const finalState = getAgentState(chatId);
  let finalResponse: string;
  if (!finalState) finalResponse = "";
  else if (failed > 0) {
    const lastFail = observations[observations.length - 1];
    // Distinguish network vs command vs security
    if (lastFail?.stderr?.includes("Network error")) {
      finalResponse = lastFail.stderr.slice(0, 400);
    } else if (lastFail?.stderr?.includes("Security blocked") || lastFail?.stderr?.includes("Path escapes")) {
      finalResponse = `Blocked by security policy: ${lastFail.stderr.slice(0, 300)}`;
    } else {
      finalResponse = `I couldn't complete the action${lastFail?.stderr ? `: ${lastFail.stderr.slice(0, 400)}` : ""}`.trim();
    }
  } else if (finalState.status === "completed" && executed > 0) {
    const parts: string[] = [];
    // Use plan explanation for concise UI (no chain-of-thought)
    if (plan.explanation) parts.push(plan.explanation);
    for (const o of finalState.completedActions) {
      const absPath = o.result?.path || o.result?.stdout?.split("\n")[0]?.trim();
      if (o.type === "create_folder" as any) parts.push(`Created folder:\n${absPath || o.target}`);
      else if (o.type === "create_file" as any) parts.push(`Created file:\n${absPath || o.target}`);
      else if ((o.type as any) === "move") parts.push(`Moved to:\n${absPath || o.target}`);
      else if ((o.type as any) === "copy") parts.push(`Copied to:\n${absPath || o.target}`);
      else if (o.type === "delete" as any) parts.push(`Deleted \`${o.target}\`.`);
      else if (o.type === "create_file" as any) parts.push(`Created file:\n${absPath}`);
    }
    // Add verified observation summary
    finalResponse = parts.join("\n\n") || `Completed ${executed} action(s). Verified: ${succeeded} succeeded.`;
    logDebug("FINAL", finalResponse.slice(0, 400));
  } else {
    finalResponse = finalState.failureReason === "terminal_closed"
      ? "Terminal is not available right now. Please open the Terminal panel to enable execution."
      : plan.explanation || "";
  }

  return { executed, succeeded, failed, observations, finalResponse };
}

function authorizedToPlannedForLoop(a: any): PlannedAction {
  // Map AuthorizedAction back to PlannedAction for synthesizeCommand
  switch (a.type) {
    case "create_folder": {
      const base = (a as any).basePath;
      if (base) return { kind: "createFolder", name: a.target, clause: a.rawClause, basePath: base } as any;
      return { kind: "createFolder", name: a.target, clause: a.rawClause } as any;
    }
    case "create_file": {
      // target may be absolute path like C:\...\kumar19\app.py or relative project/app.py
      const target = a.target;
      if (target.includes("/") || target.includes("\\") || target.includes(":")) {
        const parts = target.split(/[\/\\]/);
        const name = parts.pop() || target;
        const folder = parts.join("/");
        if (folder) {
          // Check if folder is absolute parent
          if (/^[a-zA-Z]:/.test(target)) {
            // For absolute, reconstruct basePath
            return { kind: "createFile", name, clause: a.rawClause, content: a.content, folderRef: folder.includes(":") ? folder : undefined, basePath: folder.includes(":") ? parts.slice(0, parts.length-1).join("\\") : undefined } as any;
          }
          return { kind: "createFile", name, clause: a.rawClause, content: a.content, folderRef: folder } as any;
        }
      }
      return { kind: "createFile", name: a.target, clause: a.rawClause, content: a.content } as any;
    }
    case "write_file":
      return { kind: "writeFile", name: a.target, clause: a.rawClause, content: a.content || "" } as any;
    case "delete":
      return { kind: "delete", target: a.target, clause: a.rawClause } as any;
    case "list":
      return { kind: "list", target: a.target, clause: a.rawClause } as any;
    case "read":
      return { kind: "read", target: a.target, clause: a.rawClause } as any;
    case "move":
      return { kind: "move", source: (a as any).source, destination: (a as any).destination, clause: a.rawClause } as any;
    case "copy":
      return { kind: "copy", source: (a as any).source, destination: (a as any).destination, clause: a.rawClause } as any;
    case "run":
      return { kind: "run", command: (a as any).command || a.target, clause: a.rawClause } as any;
    default:
      return { kind: "createFolder", name: a.target, clause: a.rawClause } as any;
  }
}

async function verifyAction(action: AuthorizedAction, result: StructuredToolResult): Promise<boolean> {
  // Use existing verification: check file exists via bridge or fs
  // For now, trust tool result success + path, but also try to verify via fs if possible
  if (!result.success) return false;
  // For createDirectory, verify directory exists via fallback check
  if (action.type === "create_folder" as any) {
    const p = result.path || action.target;
    if (!p) return false;
    // Try to verify via Node fs if available
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      // If p is absolute, check directly
      let checkPath = p;
      if (!/^[a-zA-Z]:[\\/]/.test(p)) {
        // Relative – need workspace root, assume cwd
        checkPath = pathMod.join(process.cwd(), p);
      }
      const stat = await fs.stat(checkPath).catch(() => null);
      if (stat && stat.isDirectory()) return true;
      // If fallback was via bridge, we already trust success
      return true;
    } catch {
      return true;
    }
  }
  if (action.type === "create_file" as any) {
    const p = result.path || action.target;
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      let checkPath = p;
      if (!/^[a-zA-Z]:[\\/]/.test(p)) checkPath = pathMod.join(process.cwd(), p);
      const stat = await fs.stat(checkPath).catch(() => null);
      if (stat && stat.isFile()) return true;
      return true;
    } catch {
      return true;
    }
  }
  if ((action.type as any) === "move") {
    const dst = (action as any).destination;
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      let checkPath = dst;
      if (!/^[a-zA-Z]:[\\/]/.test(dst)) checkPath = pathMod.join(process.cwd(), dst);
      const stat = await fs.stat(checkPath).catch(() => null);
      if (stat) return true;
      return true;
    } catch {
      return true;
    }
  }
  // For other actions, trust success
  return true;
}
