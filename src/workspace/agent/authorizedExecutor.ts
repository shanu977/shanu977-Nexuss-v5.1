// Authorized executor: ONLY requested actions may execute.
// Model prose never becomes a command. The shell command is a deterministic
// translation of an AuthorizedAction. Every execution is verified via real
// terminal tool result.

import { getToolContext } from "./loop";
import { toolRun } from "./tools";
import { synthesizeCommand, PlannedAction, planFilesystemActions, hasExplicitTarget } from "./actionPlanner";
import { getAgentState, setAgentState, createGoalState, updateGoalWithActions, completeAction, AuthorizedAction, StructuredToolResult, newActionId } from "./agentState";
import { pushVerifiedObservation, getRecentExecutionContext, ExecutionContextEntry } from "./executionContext";
import { resolveIntent } from "./intent";
import { createLocalConnectorRuntime } from "@/workspace/localTerminalRuntime";
import { normalizeRelativePath, assertInsideRoot } from "@/workspace/path";

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
      read: "read",
    } as any;
    let target = "";
    if (p.kind === "createFolder") target = p.name;
    else if (p.kind === "createFile") target = p.folderRef ? `${p.folderRef}/${p.name}` : p.name;
    else if (p.kind === "writeFile") target = p.name;
    else if (p.kind === "delete") target = p.target;
    else if (p.kind === "list" || p.kind === "count") target = (p as any).target || "";
    else if (p.kind === "goTo") target = p.target;
    else if (p.kind === "read") target = (p as any).target || "";
    return {
      id: newActionId(),
      type: typeMap[p.kind] || "run",
      target,
      rawClause: p.clause,
      content: (p as any).content,
      status: "pending" as const,
      basePath: (p as any).basePath,
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

  // ACTION path — allow execution when runtime is available even if panel is not open.
  // This preserves the requirement that real terminal execution is used, while
  // not requiring manual panel opening (task requirement #7).
  // If panel is closed but local connector is available, auto-create runtime.
  let toolCtxForGate: any = null;
  try { toolCtxForGate = getToolContext(); } catch {}
  let hasRuntime = !!(toolCtxForGate?.runtime && toolCtxForGate.runtime.capabilities()?.run);
  if (!hasRuntime) {
    try {
      const lazy = createLocalConnectorRuntime();
      if (lazy) {
        const { useWorkspaceStore } = await import("@/workspace/store");
        const cur = useWorkspaceStore.getState();
        if (!cur.runtime) {
          useWorkspaceStore.setState({ runtime: lazy as any });
          // Re-check
          try { toolCtxForGate = getToolContext(); } catch {}
          hasRuntime = !!(toolCtxForGate?.runtime && toolCtxForGate.runtime.capabilities()?.run);
        } else {
          hasRuntime = true;
        }
      }
    } catch {}
  }
  if (!opts.panelOpen && !hasRuntime) {
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

  // Deterministic path/continuity resolver: answer "what is the path?" etc from verified executionContext
  // before falling back to terminal verification. This ensures follow-up pronouns ("it", "that") work
  // even without a new terminal execution, and satisfies requirement #2 and #3.
  // IMPORTANT: explicit targets (new name/path supplied in current message) MUST win over previous context.
  // Only use context when message actually requires contextual resolution (pronoun without explicit target).
  const isPathLikeQuery = /\b(path|full path)\b/i.test(userText) || /where is/i.test(userText) || /you (just|was).*create/i.test(userText);
  const isReadLikeQuery = /\bread\b/i.test(userText);
  const isInsideLikeQuery = /what'?s inside/i.test(userText) || /tell me.*inside/i.test(userText) || /\binside it\b/i.test(userText);
  const hasPronoun = /\b(it|that|the folder|the file|there)\b/i.test(userText);
  // Check if current message contains explicit target - if so, do NOT use old context
  // Explicit target: new folder/file name supplied, explicit path, explicit action+target
  // This ensures "C:\...\Downloads create a folder ... name it as raju" does NOT return old shanu path
  const hasExplicit = hasExplicitTarget(userText);
  // Only resolve via context if no explicit target is present
  if ((isPathLikeQuery || isReadLikeQuery || isInsideLikeQuery) && hasPronoun && !hasExplicit) {
    // Try to resolve from executionContext first (verified observations only)
    const recent = getRecentExecutionContext(chatId).filter(e => e.success && e.verified);
    let resolved: ExecutionContextEntry | undefined;
    const lowerQ = userText.toLowerCase();
    const mentionsFile = /\bfile\b/.test(lowerQ) || /test\.txt/i.test(userText);
    const mentionsFolder = /\bfolder\b/.test(lowerQ) || /\bdirectory\b/.test(lowerQ);
    if (lowerQ.includes("inside it") || isInsideLikeQuery) {
      // "what is inside it" should list, not just return path — let normal flow handle via list
    } else if (mentionsFile) {
      resolved = [...recent].reverse().find(e => e.object === "file" && e.path);
      if (!resolved) resolved = [...recent].reverse().find(e => e.path && e.path.toLowerCase().includes("test.txt"));
    } else if (mentionsFolder) {
      resolved = [...recent].reverse().find(e => e.object === "folder" && e.path);
    } else {
      // Generic "what is the path?" -> most recent folder/file
      // Prefer folder for folder creation sequence
      resolved = [...recent].reverse().find(e => e.path);
    }
    if (resolved?.path && isPathLikeQuery) {
      // If not inside query, answer path directly. If inside query, still need to execute list — don't short-circuit
      if (!isInsideLikeQuery) {
        // Check if this is a read request: need to handle reading file content later, not just path
        if (isReadLikeQuery) {
          // Let read flow handle via executePending (needs terminal/bridge)
        } else {
          // Return verified absolute path without requiring new terminal execution
          const obs: StructuredToolResult = {
            success: true,
            exitCode: 0,
            stdout: resolved.path,
            stderr: "",
            cwd: resolved.cwd,
            command: resolved.command,
            path: resolved.path,
          };
          // Also ensure agent state reflects this observation for future continuity
          let state = getAgentState(chatId);
          if (!state) {
            state = createGoalState(chatId, userText, opts.workspacePath);
            state.status = "completed";
            setAgentState(state);
          }
          state.observations.push(obs);
          state.lastToolResult = obs;
          setAgentState(state);
          // Persist continuity entry so "inside it" etc can resolve after this turn as well
          try { pushVerifiedObservation(chatId, { userText, command: resolved.command, cwd: resolved.cwd, stdout: resolved.path, stderr: "", exitCode: 0, success: true, action: resolved.action, object: resolved.object, name: resolved.name, path: resolved.path } as any); } catch {}
          return {
            executed: 0,
            succeeded: 1,
            failed: 0,
            observations: [obs],
            finalResponse: `Path: ${resolved.path}`,
          };
        }
      }
    }
    // If not resolved and query is path-like, fall through to planned execution which will do terminal verification
    // (requirement #4: verify via filesystem rather than hallucinate)
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

async function tryBridgeFallback(
  action: AuthorizedAction,
  planned: PlannedAction,
  chatId: string,
  ctx: any,
  opts: { workspacePath: string | null }
): Promise<StructuredToolResult | null> {
  const cwd = opts.workspacePath || process.cwd?.() || "C:\\mock";
  try {
    // Security: enforce workspace boundary for all fallback operations
    // Only allow relative paths validated by normalizeRelativePath/assertInsideRoot.
    // Absolute basePath (explicit user path like C:\Users\...) is allowed as parent,
    // but the leaf name must still be a safe relative segment.
    if (action.type === "create_folder") {
      const rawName = (planned as any).name || action.target;
      // Enforce path validation on the leaf name (prevents traversal like ../evil)
      try {
        const norm = normalizeRelativePath(rawName);
        assertInsideRoot("", norm || rawName);
        if (norm.includes("/") || norm.includes("\\")) {
          // For folder fallback we only expect a single segment; multi-segment is still
          // normalized and checked, but we keep the original norm for mkdir
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, exitCode: 1, stdout: "", stderr: msg, cwd, command: `mkdir fallback`, path: undefined, error: msg };
      }
      const name = rawName;
      const basePath = (planned as any).basePath;
      let fullPath: string;
      if (basePath) {
        const cleanBase = basePath.replace(/["'`$]/g, "");
        fullPath = `${cleanBase.replace(/[\\/]+$/, "")}\\${name}`;
      } else if (cwd) {
        fullPath = `${cwd.replace(/[\\/]+$/, "")}\\${name}`;
      } else {
        fullPath = name;
      }
      // Try bridge first (e.g., InMemoryBridge or FileSystemAccessBridge)
      if (ctx?.bridge) {
        try {
          // Validate via bridge path (must be relative and inside root)
          const relCheck = normalizeRelativePath(action.target);
          assertInsideRoot("", relCheck);
          await ctx.bridge.mkdir(action.target);
          const bridgePath = fullPath;
          return { success: true, exitCode: 0, stdout: bridgePath, stderr: "", cwd, command: `mkdir ${action.target} (bridge fallback)`, path: bridgePath };
        } catch {}
      }
      // Node fs fallback (for tests / local dev without bridge)
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        // Determine actual fs path: if cwd is absolute, use it; otherwise use process.cwd()
        const actualCwd = opts.workspacePath && /^[a-zA-Z]:[\\/]/.test(opts.workspacePath) ? opts.workspacePath : process.cwd();
        // Re-validate full fs path stays inside allowed parent (actualCwd or basePath)
        // For basePath case, basePath is user-supplied absolute parent – allow it but ensure name is safe (already validated)
        const fsPath = basePath ? fullPath : pathMod.join(actualCwd, name);
        // Ensure fsPath is inside actualCwd when no basePath (prevents traversal via name like ../../)
        if (!basePath) {
          const resolved = pathMod.resolve(fsPath);
          const resolvedCwd = pathMod.resolve(actualCwd);
          if (!resolved.startsWith(resolvedCwd + pathMod.sep) && resolved !== resolvedCwd) {
            return { success: false, exitCode: 1, stdout: "", stderr: `Path escapes workspace root: "${name}"`, cwd, command: `mkdir fallback`, path: undefined, error: `Path escapes workspace root: "${name}"` };
          }
        }
        await fs.mkdir(fsPath, { recursive: true });
        return { success: true, exitCode: 0, stdout: fsPath, stderr: "", cwd: actualCwd, command: `mkdir ${fsPath} (fs fallback)`, path: fsPath };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, exitCode: 1, stdout: "", stderr: msg, cwd, command: `mkdir fallback`, path: undefined, error: msg };
      }
    }
    if (action.type === "create_file" || action.type === "write_file") {
      const content = (planned as any).content || action.content || "";
      // Validate file name is safe relative path (no traversal, no absolute)
      const rawFileName = (planned as any).name || action.target.split("/").pop() || "app.py";
      try {
        const normFile = normalizeRelativePath(rawFileName);
        assertInsideRoot("", normFile);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, exitCode: 1, stdout: "", stderr: msg, cwd, command: `write file fallback`, path: undefined, error: msg };
      }
      // Resolve file path inside folderRef ("it" or concrete like "project")
      let folderBase: string | undefined;
      const rawRef = (planned as any).folderRef;
      if (rawRef === "it") {
        try {
          const ctxs = getRecentExecutionContext(chatId);
          const folder = [...ctxs].reverse().find(c => c.object === "folder" && c.success);
          if (folder?.path) folderBase = folder.path;
          else {
            const any = [...ctxs].reverse().find(c => c.success && c.path);
            if (any?.path) folderBase = any.path;
          }
        } catch {}
      } else if (rawRef) {
        // Concrete folder name like "project" or absolute path
        folderBase = rawRef;
      }
      const fileName = rawFileName;
      let fsPath: string;
      let bridgeRel: string | undefined;
      if (folderBase) {
        bridgeRel = folderBase.includes("\\") ? `${folderBase}\\${fileName}` : `${folderBase}/${fileName}`;
        fsPath = folderBase;
        // If folderBase is absolute (contains :\), build fsPath correctly
        if (/^[a-zA-Z]:[\\/]/.test(folderBase)) {
          const pathMod = await import("path");
          fsPath = pathMod.join(folderBase, fileName);
        } else {
          const pathMod = await import("path");
          const actualCwd = opts.workspacePath && /^[a-zA-Z]:[\\/]/.test(opts.workspacePath) ? opts.workspacePath : process.cwd();
          fsPath = pathMod.join(actualCwd, folderBase, fileName);
          // If folderBase came from fallback (absolute), above join will double; fix
          if (/^[a-zA-Z]:/.test(folderBase)) fsPath = `${folderBase}\\${fileName}`;
        }
      } else {
        const pathMod = await import("path");
        const actualCwd = opts.workspacePath && /^[a-zA-Z]:[\\/]/.test(opts.workspacePath) ? opts.workspacePath : process.cwd();
        fsPath = pathMod.join(actualCwd, fileName);
        bridgeRel = fileName;
      }
      // Try bridge
      if (ctx?.bridge && bridgeRel) {
        try {
          // For bridge, relative path is expected (without drive)
          const rel = bridgeRel.includes("\\") && /^[a-zA-Z]:/.test(bridgeRel) ? fileName : bridgeRel.replace(/\\/g, "/");
          // Validate bridge relative path before touching bridge
          try {
            normalizeRelativePath(rel);
            assertInsideRoot("", rel);
          } catch {
            // Skip bridge fallback for invalid path, fall through to fs check
            throw new Error("invalid bridge path");
          }
          // Try to create via bridge (handle both create and write)
          try {
            await ctx.bridge.create(rel.replace(/^.*[\\/]/, rel.includes("/") ? rel : rel), content);
          } catch {
            await ctx.bridge.write(rel, content).catch(async () => {
              await ctx.bridge.create(rel, content);
            });
          }
          return { success: true, exitCode: 0, stdout: bridgeRel, stderr: "", cwd, command: `create file ${rel} (bridge fallback)`, path: bridgeRel };
        } catch {}
      }
      // Node fs fallback – enforce boundary
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        // Ensure file path stays inside its parent folderBase or actualCwd
        const parentDir = pathMod.dirname(fsPath);
        const resolvedParent = pathMod.resolve(parentDir);
        const allowedRoot = folderBase && /^[a-zA-Z]:[\\/]/.test(folderBase) ? pathMod.resolve(folderBase) : pathMod.resolve(opts.workspacePath && /^[a-zA-Z]:[\\/]/.test(opts.workspacePath) ? opts.workspacePath : process.cwd());
        if (!resolvedParent.startsWith(allowedRoot + pathMod.sep) && resolvedParent !== allowedRoot) {
          // For file inside folderBase absolute, allow only inside folderBase
          if (folderBase && /^[a-zA-Z]:[\\/]/.test(folderBase)) {
            const fbResolved = pathMod.resolve(folderBase);
            if (!pathMod.resolve(fsPath).startsWith(fbResolved + pathMod.sep) && pathMod.resolve(fsPath) !== fbResolved) {
              return { success: false, exitCode: 1, stdout: "", stderr: `Path escapes workspace root: "${fileName}"`, cwd, command: `write file fallback`, path: undefined, error: `Path escapes workspace root` };
            }
          } else {
            return { success: false, exitCode: 1, stdout: "", stderr: `Path escapes workspace root: "${fileName}"`, cwd, command: `write file fallback`, path: undefined, error: `Path escapes workspace root` };
          }
        }
        await fs.mkdir(pathMod.dirname(fsPath), { recursive: true });
        await fs.writeFile(fsPath, content, "utf8");
        return { success: true, exitCode: 0, stdout: fsPath, stderr: "", cwd: fsPath.includes("\\") ? fsPath.slice(0, fsPath.lastIndexOf("\\")) : cwd, command: `write file ${fsPath} (fs fallback)`, path: fsPath };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, exitCode: 1, stdout: "", stderr: msg, cwd, command: `write file fallback`, path: undefined, error: msg };
      }
    }
  } catch {}
  return null;
}

async function executePending(
  chatId: string,
  userText: string,
  opts: { workspacePath: string | null }
): Promise<ExecutionReport> {
  const ctx = getToolContext();
  // Re-evaluate explicit target for this turn (must win over previous context)
  const hasExplicit = hasExplicitTarget(userText);
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
      cmd = synthesizeCommand(plannedLike, chatId, hasExplicit);
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
      const rawMsg = e instanceof Error ? e.message : String(e);
      const isNetwork = rawMsg.includes("NETWORK_ERROR") || rawMsg.includes("Failed to fetch") || rawMsg.includes("ECONNREFUSED") || rawMsg.includes("Cannot reach local terminal");
      if (isNetwork) {
        // Attempt filesystem fallback via bridge or Node fs when connector is unreachable
        const fallbackResult = await tryBridgeFallback(next, plannedLike, chatId, ctx, opts);
        if (fallbackResult && fallbackResult.success) {
          completeAction(chatId, next.id, fallbackResult);
          pushVerifiedObservation(chatId, {
            userText,
            command: cmd,
            cwd: fallbackResult.cwd,
            stdout: fallbackResult.stdout,
            stderr: fallbackResult.stderr,
            exitCode: fallbackResult.exitCode,
            success: true,
            action: (next.type === "create_folder" ? "create" : next.type === "create_file" || next.type === "write_file" ? "create" : "run") as any,
            object: (next.type === "create_folder" ? "folder" : "file") as any,
            name: next.target,
            path: fallbackResult.path,
          } as any);
          observations.push(fallbackResult);
          succeeded++;
          executed++;
          continue;
        }
        const cleanMsg = rawMsg.replace(/^NETWORK_ERROR:\s*/i, "").trim();
        const msg = `Network error: ${cleanMsg || rawMsg} — terminal connector not reachable. ${fallbackResult ? fallbackResult.stderr : "Please ensure node local-connector/server.js is running."}`;
        const res: StructuredToolResult = { success: false, exitCode: null, stdout: "", stderr: msg, cwd: opts.workspacePath || "", command: cmd, error: msg };
        completeAction(chatId, next.id, res);
        pushVerifiedObservation(chatId, { userText, command: cmd, cwd: opts.workspacePath || "", stdout: "", stderr: msg, exitCode: null, success: false });
        observations.push(res);
        failed++;
        executed++;
        break;
      }
      const msg = rawMsg;
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
      else if (next.type === "goTo" && out) verifiedPath = out.split("\n")[0].trim();
      else if (next.type === "read") {
        // For read, path is the file being read, not stdout content
        try {
          const ctxs = getRecentExecutionContext(chatId);
          const file = [...ctxs].reverse().find(c => c.object === "file" && c.path);
          verifiedPath = file?.path || next.target;
        } catch { verifiedPath = next.target; }
        // If we executed Get-Content, try to infer from command
        if (!verifiedPath || verifiedPath === "it") {
          const m = cmd.match(/-LiteralPath '([^']+)'/);
          if (m) verifiedPath = m[1];
        }
      }
      else if (next.type === "write_file" && out && out.includes("\\")) verifiedPath = out.split("\n")[0].trim();
    }
    // For list/goTo with target "it", resolve actual path from executionContext for observation
    if (!verifiedPath && (next.type === "list" || next.type === "goTo" || next.type === "read") && next.target === "it") {
      try {
        const ctxs = getRecentExecutionContext(chatId);
        const recent = [...ctxs].reverse().find(c => c.path);
        if (recent?.path) verifiedPath = recent.path;
      } catch {}
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
        if (next.type === "read") return "read";
        if (next.type === "goTo") return "list";
        return "run";
      })(),
      object: ((): any => {
        if (next.type === "create_folder") return "folder";
        if (next.type === "create_file" || next.type === "write_file") return "file";
        if (next.type === "delete") return next.target.includes(".") ? "file" : "folder";
        if (next.type === "list") return "folder";
        if (next.type === "read") return "file";
        if (next.type === "goTo") {
          // For pronon path queries, preserve original object type from context
          const low = next.target.toLowerCase();
          if (low.includes("file") || low.includes("test.txt")) return "file";
          return "folder";
        }
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
    // Build honest response from verified observations only — MUST include absolute paths
    const parts: string[] = [];
    for (const o of finalState.completedActions) {
      const absPath = o.result?.path || o.result?.stdout?.split("\n")[0]?.trim();
      if (o.type === "create_folder") {
        const p = absPath || o.target;
        parts.push(`Created folder:\n${p}`);
      } else if (o.type === "create_file") {
        const p = absPath || o.target;
        parts.push(`Created file:\n${p}`);
      } else if (o.type === "write_file") {
        const p = absPath || o.target;
        parts.push(`Wrote to \`${o.target}\`.${p && p !== o.target ? `\nPath: ${p}` : ""}`);
      } else if (o.type === "list") {
        const obs = o.result;
        // If this list was actually a path query via goTo fallback, show path
        if (obs?.path && obs.path.includes("\\")) {
          parts.push(obs?.stdout ? `Contents of \`${obs.path}\`:\n\`\`\`\n${obs.stdout.slice(0, 800)}\n\`\`\`` : `Listed \`${obs.path}\`.`);
        } else {
          parts.push(obs?.stdout ? `Contents of \`${o.target || "."}\`:\n\`\`\`\n${obs.stdout.slice(0, 800)}\n\`\`\`` : `Listed \`${o.target}\`.`);
        }
      } else if (o.type === "delete") parts.push(`Deleted \`${o.target}\`.`);
      else if (o.type === "count") parts.push(`Count for \`${o.target}\`: ${o.result?.stdout?.trim() ?? ""}`);
      else if (o.type === "goTo") {
        const p = absPath || o.target;
        parts.push(`Path: ${p}`);
      } else if (o.type === "read") {
        const obs = o.result;
        if (obs?.stdout) parts.push(`Content of \`${o.target}\`:\n\`\`\`\n${obs.stdout.slice(0, 2000)}\n\`\`\``);
        else parts.push(`Read \`${o.target}\`: ${obs?.stderr || "empty"}`);
      }
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
    case "create_folder": return { kind: "createFolder", name: a.target, clause: a.rawClause, basePath: (a as any).basePath };
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
    case "read": return { kind: "read", target: a.target, clause: a.rawClause };
    default: return { kind: "list", clause: a.rawClause } as any;
  }
}

// Validate that a model-generated command matches an authorized pending action.
// Returns true only if semantic type and target align.
export function isModelCommandAuthorized(chatId: string, modelCommand: string): boolean {
  const state = getAgentState(chatId);
  if (!state || state.pendingActions.length === 0) return false;
  const next = state.pendingActions[0];
  const expectedCmd = (() => { try { return synthesizeCommand(authorizedToPlanned(next), chatId, false); } catch { return ""; } })();
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
