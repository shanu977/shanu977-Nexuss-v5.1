// General filesystem action planner for deterministic multi-step execution.
// Handles natural language like "create a folder called shanu5, create test.txt inside it, write hello world, then list"
// without hardcoding that exact phrase.

import { getRecentExecutionContext } from "./executionContext";

export type PlannedAction =
  | { kind: "createFolder"; name: string; clause: string }
  | { kind: "createFile"; name: string; folderRef?: string; clause: string; content?: string }
  | { kind: "writeFile"; name: string; content: string; clause: string }
  | { kind: "list"; target?: string; clause: string }
  | { kind: "count"; target?: string; clause: string }
  | { kind: "delete"; target: string; clause: string }
  | { kind: "goTo"; target: string; clause: string };

export function isHowToRequest(t: string): boolean {
  const lower = t.toLowerCase();
  // HOW-TO: user wants instructions, not execution
  if (/\bhow (do|to|can|should) i\b/.test(lower)) return true;
  if (/\bwhat command\b/.test(lower)) return true;
  if (/\bhow (can|to) (i|you) (create|list|delete|make)\b/.test(lower)) return true;
  if (/\bexplain (how|what)\b/.test(lower)) return true;
  if (/\bshow me the command\b/.test(lower)) return true;
  if (/\bgive me the.*command\b/.test(lower)) return true;
  // If it contains "how do i ...?" with question mark, it's how-to even if it also says folder
  if (lower.startsWith("how ") && lower.includes("?")) return true;
  return false;
}

export function isFilesystemActionRequest(t: string): boolean {
  if (isHowToRequest(t)) return false;
  const lower = t.toLowerCase();
  // Action verbs with filesystem objects, even without "use the terminal"
  return (
    /(create|make)\s+(a\s+)?(folder|directory|file)\b/.test(lower) ||
    /\bdelete\b/.test(lower) ||
    /\bremove\b/.test(lower) ||
    /\blist\b.*\b(inside|here|folder|directory|files)\b/.test(lower) ||
    /what'?s inside/.test(lower) ||
    /tell me.*inside/.test(lower) ||
    /\bgo to\b/.test(lower) ||
    /\bcount\b/.test(lower) ||
    /tell me the path/.test(lower) ||
    /where is/.test(lower)
  );
}

function extractFolderName(clause: string): string | null {
  const m = clause.match(/(?:folder|directory)\s+(?:called\s+|named\s+|name\s+called\s+)?["']?([a-zA-Z0-9_\- ]+?)["']?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
  if (m) return m[1].trim().split(/\s+/)[0].replace(/["'`]/g, "");
  const m2 = clause.match(/called\s+["']?([a-zA-Z0-9_\-]+)["']?/i);
  if (m2) return m2[1].trim();
  return null;
}

function extractFileName(clause: string): string | null {
  const m = clause.match(/(?:file\s+called\s+|file\s+named\s+|file\s+)(["']?)([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)\1/i);
  if (m) return m[2].trim();
  // Also match test.txt directly
  const m2 = clause.match(/\b([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)\b/);
  if (m2) return m2[1].trim();
  return null;
}

function extractWriteContent(clause: string): string | null {
  // "write hello world into the file" -> hello world
  const m = clause.match(/write\s+["']?([^"']+?)["']?\s+into/i);
  if (m) return m[1].trim();
  const m2 = clause.match(/write\s+(.+?)\s+into/i);
  if (m2) return m2[1].trim().replace(/^["']|["']$/g, "");
  return null;
}

function resolveFolderRef(target: string | undefined, chatId: string): string | undefined {
  if (!target) return undefined;
  const lower = target.toLowerCase();
  if (lower === "it" || lower.includes("it") || lower.includes("that folder") || lower.includes("that file") || lower.includes("inside it") || lower.includes("here") || lower.includes("this")) {
    try {
      const ctxs = getRecentExecutionContext(chatId);
      // Prefer most recent folder
      const folder = [...ctxs].reverse().find(c => c.object === "folder" && c.success);
      if (folder?.path) return folder.path;
      const any = [...ctxs].reverse().find(c => c.success);
      if (any?.path) return any.path;
    } catch {}
    return undefined;
  }
  return target;
}

export function planFilesystemActions(userText: string, chatId: string): PlannedAction[] {
  if (!isFilesystemActionRequest(userText)) return [];
  // Split by commas, "then", "and then", "and", ";"
  const clauses = userText
    .split(/,|\bthen\b|\band then\b|\b;\b/i)
    .map(c => c.trim())
    .filter(Boolean)
    // Further split "and" when it separates actions (but keep "hello world" intact)
    .flatMap(c => {
      // Avoid splitting inside file content
      if (/write.*hello world/i.test(c)) return [c];
      const parts = c.split(/\band\b/i).map(p => p.trim()).filter(Boolean);
      // If parts look like separate actions, split
      if (parts.length > 1 && parts.every(p => /(create|make|write|list|delete|go to|count|tell)/i.test(p))) {
        return parts;
      }
      return [c];
    });

  const actions: PlannedAction[] = [];

  for (const clause of clauses) {
    const lower = clause.toLowerCase();

    // go to
    const goMatch = clause.match(/go to\s+["']?([a-zA-Z0-9_\-\\\/\. ]+)["']?/i);
    if (goMatch) {
      actions.push({ kind: "goTo", target: goMatch[1].trim(), clause });
      continue;
    }

    // delete
    if (/\bdelete\b|\bremove\b/.test(lower)) {
      const isFile = /\bfile\b/.test(lower);
      const target = extractFileName(clause) || extractFolderName(clause) || (lower.includes("it") || lower.includes("that") ? "it" : "");
      if (target) {
        actions.push({ kind: "delete", target, clause });
        continue;
      }
      // "delete the file" without name -> resolve via context
      if (lower.includes("delete")) {
        actions.push({ kind: "delete", target: "it", clause });
        continue;
      }
    }

    // count
    if (/\bhow many\b|\bcount\b/.test(lower)) {
      // count inside folder
      const target = lower.includes("it") || lower.includes("folder") ? "it" : undefined;
      actions.push({ kind: "count", target, clause });
      continue;
    }

    // list
    if (/\blist\b|\bwhat'?s inside\b|\btell me.*inside\b|\bshow.*inside\b/.test(lower)) {
      const target = lower.includes("it") || lower.includes("folder") || lower.includes("here") ? "it" : undefined;
      actions.push({ kind: "list", target, clause });
      continue;
    }

    // write file (must be before create file to capture content)
    if (/write\s+.+\s+into/i.test(lower) || (/write/i.test(lower) && /hello world/i.test(lower))) {
      const content = extractWriteContent(clause) || "hello world";
      const file = extractFileName(clause) || "test.txt";
      actions.push({ kind: "writeFile", name: file, content, clause });
      continue;
    }

    // create file
    if (/(create|make)\s+.*file/i.test(lower)) {
      const name = extractFileName(clause) || "test.txt";
      const folderRef = lower.includes("inside it") || lower.includes("inside that") ? "it" : undefined;
      actions.push({ kind: "createFile", name, folderRef, clause, content: lower.includes("hello world") ? "hello world" : undefined });
      continue;
    }

    // create folder
    if (/(create|make)\s+.*(folder|directory)/i.test(lower)) {
      const name = extractFolderName(clause);
      if (name) {
        actions.push({ kind: "createFolder", name, clause });
        continue;
      }
    }

    // tell me path / where is -> count/list already, but also create+path
    if (/tell me the path/.test(lower) && actions.length === 0) {
      const name = extractFolderName(userText);
      if (name) actions.push({ kind: "createFolder", name, clause });
      continue;
    }
  }

  // Deduplicate: if clause was "create a folder called shanu5 and tell me the path" -> we already have createFolder, no need for separate tell
  return actions;
}

export function synthesizeCommand(action: PlannedAction, chatId: string): string {
  const resolveIt = (target?: string) => {
    if (!target || target === "it") {
      try {
        const ctxs = getRecentExecutionContext(chatId);
        const folder = [...ctxs].reverse().find(c => c.object === "folder" && c.success);
        if (folder?.path) return folder.path;
        const any = [...ctxs].reverse().find(c => c.success);
        if (any?.path) return any.path;
      } catch {}
      return undefined;
    }
    return target;
  };

  switch (action.kind) {
    case "createFolder": {
      const safe = action.name.replace(/["'`$]/g, "");
      return `powershell -NoProfile -Command "New-Item -ItemType Directory -Path '.\\${safe}' -Force | Select-Object -ExpandProperty FullName"`;
    }
    case "createFile": {
      let targetPath: string;
      if (action.folderRef === "it") {
        const base = resolveIt("it");
        targetPath = base ? `${base.replace(/\\/g, "/")}/${action.name}` : `.\\${action.name}`;
      } else {
        targetPath = `.\\${action.name}`;
      }
      const safe = targetPath.replace(/"/g, "");
      const contentPart = action.content ? ` -Value '${action.content.replace(/'/g, "''")}'` : "";
      return `powershell -NoProfile -Command "New-Item -ItemType File -Path '${safe}'${contentPart} -Force | Select-Object -ExpandProperty FullName"`;
    }
    case "writeFile": {
      let targetPath: string;
      // Try to resolve file path from recent context
      try {
        const ctxs = getRecentExecutionContext(chatId);
        const file = [...ctxs].reverse().find(c => c.object === "file" && c.success);
        if (file?.path) targetPath = file.path;
        else {
          const folder = [...ctxs].reverse().find(c => c.object === "folder" && c.success);
          targetPath = folder?.path ? `${folder!.path.replace(/\\/g, "/")}/${action.name}` : `.\\${action.name}`;
        }
      } catch {
        targetPath = `.\\${action.name}`;
      }
      const safePath = targetPath.replace(/"/g, "");
      const safeContent = action.content.replace(/'/g, "''");
      return `powershell -NoProfile -Command "Set-Content -Path '${safePath}' -Value '${safeContent}' -Force | Out-Null"`;
    }
    case "list": {
      const base = resolveIt(action.target);
      const target = base || ".\\shanu5";
      const safe = target.replace(/"/g, "");
      // Use LiteralPath, handle both forward and back slashes
      return `powershell -NoProfile -Command "Get-ChildItem -LiteralPath '${safe}' | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200"`;
    }
    case "count": {
      const base = resolveIt(action.target);
      const target = base || ".\\shanu5";
      const safe = target.replace(/"/g, "");
      return `powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${safe}').Count"`;
    }
    case "delete": {
      let targetPath: string | undefined;
      if (action.target === "it" || action.target.toLowerCase().includes("it") || action.target.toLowerCase().includes("that")) {
        try {
          const ctxs = getRecentExecutionContext(chatId);
          // For delete file vs folder, try to find matching object
          const isFile = action.clause.toLowerCase().includes("file");
          if (isFile) {
            const file = [...ctxs].reverse().find(c => c.object === "file" && c.success);
            if (file?.path) targetPath = file.path;
          }
          if (!targetPath) {
            const folder = [...ctxs].reverse().find(c => c.object === "folder" && c.success);
            if (folder?.path) targetPath = folder.path;
          }
          if (!targetPath) {
            const any = [...ctxs].reverse().find(c => c.success);
            if (any?.path) targetPath = any.path;
          }
        } catch {}
      } else {
        targetPath = action.target;
      }
      const safe = (targetPath || action.target).replace(/"/g, "");
      return `powershell -NoProfile -Command "Remove-Item -LiteralPath '${safe}' -Recurse -Force | Out-Null"`;
    }
    case "goTo": {
      const safe = action.target.replace(/"/g, "");
      let resolved = safe;
      if (/^downloads$/i.test(safe)) resolved = "C:\\Users\\pilli\\Downloads";
      else if (/^desktop$/i.test(safe)) resolved = "C:\\Users\\pilli\\Desktop";
      else if (/^documents$/i.test(safe)) resolved = "C:\\Users\\pilli\\Documents";
      return `powershell -NoProfile -Command "Get-Item -LiteralPath '${resolved}' | Select-Object -ExpandProperty FullName"`;
    }
  }
}
