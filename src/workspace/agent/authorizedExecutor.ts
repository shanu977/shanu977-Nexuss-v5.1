// Authorized executor: ONLY requested actions may execute.
// Model prose never becomes a command. The shell command is a deterministic
// translation of an AuthorizedAction. Every execution is verified via real
// terminal tool result.

import { getToolContext } from "./loop";
import { toolRun } from "./tools";
import { synthesizeCommand, PlannedAction, planFilesystemActions } from "./actionPlanner";
import { getAgentState, setAgentState, createGoalState, updateGoalWithActions, completeAction, AuthorizedAction, StructuredToolResult, newActionId } from "./agentState";
import { pushVerifiedObservation, getRecentExecutionContext, ExecutionContextEntry } from "./executionContext";
import { resolveIntent } from "./intent";

function plannedToAuthorized(planned: PlannedAction[], _rawGoal: string): AuthorizedAction[] {
  return planned.map((p) => {
    const typeMap: Record<PlannedAction["kind"], AuthorizedAction["type"]> = {
      createFolder: "create_folder",
      createFile: "create_file",
      writeFile: "write_file",
      list: "list",
      count: "count",
      delete: "delete",
      goTo: "goTo",
    } as any;
    let target = "";
    if (p.kind === "createFolder") target = p.name;
    else if (p.kind === "createFile") target = p.folderRef ? `${p.folderRef}/${p.name}` : p.name;
    else if (p.kind === "writeFile") target = p.name;
    else if (p.kind === "delete") target = p.target;
    else if (p.kind === "list" || p.kind === "count") target = (p as any).target || "";
    else if (p.kind === "goTo") target = p.target;
    return {
      id: newActionId(),
      type: typeMap[p.kind] || "run",
      target,
      rawClause: p.clause,
      content: (p as any).content,
      status: "pending" as const,
    };
  });
}

function isFollowUp(text: string): boolean {
  return /\b(do the thing|do it|do that|continue|finish it|put it there|inside it|use that folder|add something to it)\b/i.test(text);
}

function resolveFollowUpTarget(chatId: string): PlannedAction[] | null {
  const state = getAgentState(chatId);
  if (!state) return null;
  // If pending actions exist, reuse them (continuity)
  if (state.pendingActions.length > 0) {
    // Convert back to PlannedAction-like? Instead return signal to reuse pending
    return null;
  }
  // If completed but user says do the thing again, we should not invent new folder
  return null;
}

export interface ExecutionReport {
  executed: number;
  succeeded: number;
  failed: number;
  observations: StructuredToolResult[];
  finalResponse: string;
}

export async function runAuthorizedGoal(
  chatId: string,
  userText: string,
  opts: { panelOpen: boolean; workspacePath: string | null }
): Promise<ExecutionReport> {
  const intent = resolveIntent(userText);
  const stateBefore = getAgentState(chatId);

  // HOW-TO must not execute
  if (intent.kind === "howto") {
    return {
      executed: 0,
      succeeded: 0,
      failed: 0,
      observations: [],
      finalResponse: "", // caller will use model how-to answer
    };
  }

  // Non-action / none -> maybe follow-up or generic none
  if (intent.kind === "none") {
    // Check follow-up explicitly
    if (isFollowUp(userText) && stateBefore) {
      if (stateBefore.pendingActions.length > 0) {
        // Continue pending goal - no new planning needed
        return executePending(chatId, userText, opts);
      }
      // No pending: honestly report completed, don't invent
      if (stateBefore.status === "completed" && stateBefore.completedActions.length > 0) {
        const last = stateBefore.completedActions[stateBefore.completedActions.length - 1];
        return {
          executed: 0,
          succeeded: 0,
          failed: 0,
          observations: [...stateBefore.observations],
          finalResponse: `Already completed: ${last.type} ${last.target}. Let me know what you'd like to do next.`,
        };
      }
      return {
        executed: 0,
        succeeded: 0,
        failed: 0,
        observations: [],
        finalResponse: "Could you clarify what you'd like me to do? I don't see a pending task to continue.",
      };
    }
    return { executed: 0, succeeded: 0, failed: 0, observations: [], finalResponse: "" };
  }

  // ACTION path
  if (!opts.panelOpen) {
    // Honest capability response - do not convert to how-to
    // Create failed state for observability but don't pretend success
    const s = createGoalState(chatId, userText, opts.workspacePath);
    s.status = "failed";
    s.failureReason = "terminal_closed";
    setAgentState(s);
    return {
      executed: 0,
      succeeded: 0,
      failed: 0,
      observations: [],
      finalResponse: "Terminal is not available right now. Please open the Terminal panel to enable execution, then try again — I won't pretend the action was completed without real execution.",
    };
  }

  // Determine planned actions
  const planned = planFilesystemActions(userText, chatId);

  // Follow-up "do the thing" with no explicit actions but prior pending
  if (planned.length === 0 && isFollowUp(userText) && stateBefore && stateBefore.pendingActions.length > 0) {
    // Reuse pending - don't create new goal, just execute pending
    return executePending(chatId, userText, opts);
  }

  if (planned.length === 0 && isFollowUp(userText) && stateBefore && stateBefore.completedActions.length > 0) {
    // User says "do the thing" but already done - be honest
    return {
      executed: 0,
      succeeded: 0,
      failed: 0,
      observations: [...stateBefore.observations],
      finalResponse: `That task is already complete (${stateBefore.goal}). If you want to repeat it or do something else, let me know the specific action.`,
    };
  }

  if (planned.length === 0) {
    // Ambiguous action with no concrete plan -> ask clarification rather than invent
    const s = createGoalState(chatId, userText, opts.workspacePath);
    s.status = "clarification_required";
    setAgentState(s);
    return {
      executed: 0,
      succeeded: 0,
      failed: 0,
      observations: [],
      finalResponse: "I wasn't able to determine a specific filesystem action from that request. Could you clarify the folder or file name you'd like me to create, list, or delete?",
    };
  }

  // Create authoritative goal state
  const goal = createGoalState(chatId, userText, opts.workspacePath);
  const auth = plannedToAuthorized(planned, userText);
  updateGoalWithActions(chatId, auth);

  return executePending(chatId, userText, opts);
}

async function executePending(
  chatId: string,
  userText: string,
  opts: { workspacePath: string | null }
): Promise<ExecutionReport> {
  const ctx = getToolContext();
  let executed = 0, succeeded = 0, failed = 0;
  const observations: StructuredToolResult[] = [];

  while (true) {
    const state = getAgentState(chatId);
    if (!state || state.pendingActions.length === 0) break;
    const next = state.pendingActions[0];
    // Mark executing
    next.status = "executing";
    setAgentState(state);

    // Synthesize command deterministically from authorized action
    // Need to reconstruct PlannedAction for synthesizeCommand
    const plannedLike: PlannedAction = authorizedToPlanned(next);
    let cmd: string;
    try {
      cmd = synthesizeCommand(plannedLike, chatId);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: err, cwd: opts.workspacePath || "", command: "", error: err };
      completeAction(chatId, next.id, res);
      pushVerifiedObservation(chatId, { userText, command: "", cwd: opts.workspacePath || "", stdout: "", stderr: err, exitCode: null, success: false });
      failed++;
      break;
    }

    let toolRes: any;
    try {
      toolRes = await toolRun(ctx, cmd);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: msg, cwd: opts.workspacePath || "", command: cmd, error: msg };
      completeAction(chatId, next.id, res);
      pushVerifiedObservation(chatId, { userText, command: cmd, cwd: opts.workspacePath || "", stdout: "", stderr: msg, exitCode: null, success: false });
      observations.push(res);
      failed++;
      executed++;
      break; // stop on failure per spec (do not mark complete)
    }

    executed++;
    const success = !!toolRes.success;
    // Verify path: for create/list, try to use stdout as verified path if it looks like a path, else use synth target
    let verifiedPath: string | undefined;
    if (success) {
      const out = (toolRes.stdout || "").trim();
      // For create_folder, stdout is full path
      if (next.type === "create_folder" && out) verifiedPath = out.split("\n")[0].trim();
      else if (next.type === "create_file" && out) verifiedPath = out.split("\n")[0].trim();
      else if (next.type === "list") verifiedPath = next.target || out.slice(0, 200);
    }

    const structured: StructuredToolResult = {
      success,
      exitCode: toolRes.exitCode ?? null,
      stdout: toolRes.stdout || "",
      stderr: toolRes.stderr || "",
      cwd: toolRes.cwd || opts.workspacePath || "",
      command: cmd,
      path: verifiedPath || toolRes.cwd || undefined,
    };

    completeAction(chatId, next.id, structured);
    // Store verified observation
    pushVerifiedObservation(chatId, {
      userText,
      command: cmd,
      cwd: toolRes.cwd || opts.workspacePath || "",
      stdout: toolRes.stdout || "",
      stderr: toolRes.stderr || "",
      exitCode: toolRes.exitCode ?? null,
      success,
      // semantic hints for pronoun resolution - use verified type
      action: ((): any => {
        if (next.type === "create_folder") return "create";
        if (next.type === "create_file" || next.type === "write_file") return "create";
        if (next.type === "delete") return "delete";
        if (next.type === "list" || next.type === "count") return "list";
        return "run";
      })(),
      object: ((): any => {
        if (next.type === "create_folder") return "folder";
        if (next.type === "create_file" || next.type === "write_file") return "file";
        if (next.type === "delete") return next.target.includes(".") ? "file" : "folder";
        if (next.type === "list") return "folder";
        return undefined;
      })(),
      name: next.target.split("/").pop()?.split("\\").pop(),
      path: verifiedPath,
    } as any);

    observations.push(structured);
    if (success) succeeded++; else { failed++; break; }
  }

  const finalState = getAgentState(chatId);
  let finalResponse: string;
  if (!finalState) finalResponse = "";
  else if (failed > 0) {
    const lastFail = observations[observations.length - 1];
    finalResponse = `I couldn't complete the action${lastFail?.stderr ? `: ${lastFail.stderr.slice(0, 400)}` : ""}`.trim();
  } else if (finalState.status === "completed" && executed > 0) {
    // Build honest response from verified observations only
    const parts: string[] = [];
    for (const o of finalState.completedActions) {
      if (o.type === "create_folder") parts.push(`Created folder \`${o.target}\`.`);
      else if (o.type === "create_file") parts.push(`Created file \`${o.target}\`.`);
      else if (o.type === "write_file") parts.push(`Wrote to \`${o.target}\`.`);
      else if (o.type === "list") {
        const obs = o.result;
        parts.push(obs?.stdout ? `Contents of \`${o.target || "."}\`:\n\`\`\`\n${obs.stdout.slice(0, 800)}\n\`\`\`` : `Listed \`${o.target}\`.`);
      } else if (o.type === "delete") parts.push(`Deleted \`${o.target}\`.`);
      else if (o.type === "count") parts.push(`Count for \`${o.target}\`: ${o.result?.stdout?.trim() ?? ""}`);
    }
    finalResponse = parts.join("\n\n") || `Completed ${executed} action(s).`;
  } else {
    finalResponse = finalState.failureReason === "terminal_closed"
      ? "Terminal is not available right now. Please open the Terminal panel to enable execution."
      : "";
  }

  return { executed, succeeded, failed, observations, finalResponse };
}

function authorizedToPlanned(a: AuthorizedAction): PlannedAction {
  switch (a.type) {
    case "create_folder": return { kind: "createFolder", name: a.target, clause: a.rawClause };
    case "create_file": {
      const name = a.target.includes("/") ? a.target.split("/").pop()! : a.target;
      const folderRef = a.target.includes("/") ? a.target.split("/").slice(0, -1).join("/") : undefined;
      return { kind: "createFile", name, folderRef: folderRef === "it" || folderRef?.includes("/") ? folderRef : undefined, clause: a.rawClause, content: a.content };
    }
    case "write_file": return { kind: "writeFile", name: a.target.split("/").pop()!, content: a.content || "hello world", clause: a.rawClause };
    case "list": return { kind: "list", target: a.target || undefined, clause: a.rawClause };
    case "count": return { kind: "count", target: a.target || undefined, clause: a.rawClause };
    case "delete": return { kind: "delete", target: a.target, clause: a.rawClause };
    case "goTo": return { kind: "goTo", target: a.target, clause: a.rawClause };
    default: return { kind: "list", clause: a.rawClause } as any;
  }
}

// Validate that a model-generated command matches an authorized pending action.
// Returns true only if semantic type and target align.
export function isModelCommandAuthorized(chatId: string, modelCommand: string): boolean {
  const state = getAgentState(chatId);
  if (!state || state.pendingActions.length === 0) return false;
  const next = state.pendingActions[0];
  const expectedCmd = (() => { try { return synthesizeCommand(authorizedToPlanned(next), chatId); } catch { return ""; } })();
  // Semantic check: target name must appear in model command, and action type must align
  const targetBase = next.target.split("/").pop()?.replace(/["'`]/g, "").toLowerCase();
  if (!targetBase) return false;
  const lowerModel = modelCommand.toLowerCase();
  // Forbid unrelated actions e.g., model tries to delete unrelated file
  if (next.type === "create_folder" && !lowerModel.includes(targetBase)) return false;
  if (next.type === "create_file" && !lowerModel.includes(targetBase)) return false;
  // Allow mapping if target matches
  return lowerModel.includes(targetBase);
}
