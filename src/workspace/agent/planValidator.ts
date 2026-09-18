import { normalizeRelativePath, assertInsideRoot } from "@/workspace/path";
import type { AgentPlan, PlanValidationResult } from "./llmTypes";

// Security policy: which destinations are allowed?
// For now, respect existing policy: workspace-relative paths are always allowed;
// absolute paths are allowed only if they are explicitly requested and pass validation.
// We do NOT silently rewrite absolute to workspace-relative.

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}

function containsTraversal(p: string): boolean {
  return p.includes("..") && (p.includes("../") || p.includes("..\\") || p === ".." || /\b\.\.\b/.test(p));
}

export function validateAgentPlan(plan: AgentPlan, contextWorkspaceRoot?: string): PlanValidationResult {
  if (!plan || typeof plan.intent !== "string" || !Array.isArray(plan.actions)) {
    return { valid: false, reason: "Plan missing intent or actions array", code: "INVALID_PLAN" };
  }
  if (plan.actions.length === 0) {
    // Empty actions with clarification intent is allowed (means ask user)
    if (plan.intent === "clarification") return { valid: true };
    return { valid: false, reason: "No actions in plan – ambiguous request", code: "AMBIGUOUS" };
  }
  for (const a of plan.actions) {
    if (!a.type) return { valid: false, reason: "Action missing type", code: "MISSING_FIELD" };
    switch (a.type) {
      case "createDirectory": {
        const p = (a as any).path as string;
        if (!p || typeof p !== "string") return { valid: false, reason: "createDirectory missing path", code: "MISSING_FIELD" };
        if (containsTraversal(p) && isAbsolutePath(p) === false) {
          // Traversal in relative path should be rejected – will be caught by normalize, but we give clear reason
          try {
            normalizeRelativePath(p);
          } catch (e) {
            return { valid: false, reason: `Path traversal blocked: ${p}`, code: "SECURITY" };
          }
        }
        // If absolute, do not normalize as relative – check that it's not obviously dangerous
        // We allow absolute only if explicitly requested; validator does not block absolute per se,
        // but ensures it doesn't contain traversal and is not empty
        if (p.trim().length === 0) return { valid: false, reason: "Empty path", code: "INVALID_PLAN" };
        if (containsTraversal(p)) {
          // For absolute like C:\Users\..\evil, still block traversal
          if (p.includes("..")) return { valid: false, reason: `Absolute path traversal blocked: ${p}`, code: "SECURITY" };
        }
        break;
      }
      case "createFile":
      case "writeFile": {
        const p = (a as any).path as string;
        const c = (a as any).content as string;
        if (!p || typeof p !== "string") return { valid: false, reason: `${a.type} missing path`, code: "MISSING_FIELD" };
        if (c === undefined || typeof c !== "string") return { valid: false, reason: `${a.type} missing content`, code: "MISSING_FIELD" };
        if (containsTraversal(p) && !isAbsolutePath(p)) {
          try { normalizeRelativePath(p); } catch (e) {
            return { valid: false, reason: `Path traversal blocked: ${p}`, code: "SECURITY" };
          }
        }
        break;
      }
      case "readFile":
      case "delete":
      case "listDirectory": {
        const p = (a as any).path as string;
        if (!p || typeof p !== "string") return { valid: false, reason: `${a.type} missing path`, code: "MISSING_FIELD" };
        if (containsTraversal(p) && !isAbsolutePath(p)) {
          try { normalizeRelativePath(p); } catch (e) {
            return { valid: false, reason: `Path traversal blocked: ${p}`, code: "SECURITY" };
          }
        }
        break;
      }
      case "move":
      case "copy": {
        const s = (a as any).source as string;
        const d = (a as any).destination as string;
        if (!s || !d) return { valid: false, reason: `${a.type} missing source/destination`, code: "MISSING_FIELD" };
        if (!isAbsolutePath(s) && containsTraversal(s)) {
          try { normalizeRelativePath(s); } catch (e) {
            return { valid: false, reason: `Source traversal blocked: ${s}`, code: "SECURITY" };
          }
        }
        if (!isAbsolutePath(d) && containsTraversal(d)) {
          try { normalizeRelativePath(d); } catch (e) {
            return { valid: false, reason: `Destination traversal blocked: ${d}`, code: "SECURITY" };
          }
        }
        break;
      }
      case "runCommand": {
        const cmd = (a as any).command as string;
        if (!cmd || typeof cmd !== "string" || !cmd.trim()) return { valid: false, reason: "runCommand missing command", code: "MISSING_FIELD" };
        // Dangerous command check: we don't block here heavily, executor will validate, but we can flag obvious
        if (/rm\s+-rf\s+\//.test(cmd) || /del\s+\/s\s+\/q\s+[a-z]:\\/i.test(cmd)) {
          return { valid: false, reason: "Dangerous command blocked", code: "SECURITY" };
        }
        break;
      }
      default:
        return { valid: false, reason: `Unknown action type: ${(a as any).type}`, code: "INVALID_PLAN" };
    }
  }
  // Check for obvious contradictions: e.g., same name but path mismatch
  // Example: user said "same name in Downloads" but plan has different name than recent
  // We keep this lightweight – full policy is in executor's verification
  return { valid: true };
}

export function isAbsolutePathForPolicy(p: string): boolean {
  return isAbsolutePath(p);
}
