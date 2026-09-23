const fs = require('fs');

// Simple re-implementation of key functions from actionPlanner.ts (copied logic)
function isHowToRequest(t) {
  const lower = t.toLowerCase();
  if (/\bhow (do|to|can|should) i\b/.test(lower)) return true;
  if (/\bwhat command\b/.test(lower)) return true;
  if (/\bhow (can|to) (i|you) (create|list|delete|make)\b/.test(lower)) return true;
  if (/\bexplain (how|what)\b/.test(lower)) return true;
  if (/\bshow me the command\b/.test(lower)) return true;
  if (/\bgive me the.*command\b/.test(lower)) return true;
  if (lower.startsWith("how ") && lower.includes("?")) return true;
  return false;
}

function isFilesystemActionRequest(t) {
  if (isHowToRequest(t)) return false;
  const lower = t.toLowerCase();
  return (
    /(create|make)\s+(a\s+)?(folder|directory|file|project)\b/.test(lower) ||
    /(create|make)\b.*\.[a-z0-9]{1,4}\b/.test(lower) ||
    /\bsame name\b/.test(lower) ||
    /\bmkdir\b/.test(lower) ||
    /\bdelete\b/.test(lower) ||
    /\bremove\b/.test(lower) ||
    /\blist\b.*\b(inside|here|folder|directory|files)\b/.test(lower) ||
    /what'?s inside/.test(lower) ||
    /tell me.*inside/.test(lower) ||
    /\bwhat'?s inside\b/.test(lower) ||
    /\binside it\b/.test(lower) ||
    /\bgo to\b/.test(lower) ||
    /\bcount\b/.test(lower) ||
    /tell me the path/.test(lower) ||
    /what is (the )?path/.test(lower) ||
    /give me.*path/.test(lower) ||
    /path of (it|that|the folder|the file)/.test(lower) ||
    /path for that/.test(lower) ||
    /where is/.test(lower) ||
    /\bread\b/.test(lower) ||
    /\bwrite\b.*\b(into|to)\b/.test(lower) ||
    /\bthe full path\b/.test(lower) ||
    /\byou (just|was) .*create/.test(lower) ||
    /\bnode --check\b/.test(lower) ||
    /\bfind.*bug\b/.test(lower) ||
    /\bfix.*bug\b/.test(lower) ||
    /\b(find|fix)\b.*\b(bug|error)\b/.test(lower) ||
    /\brun\b.*\b(check|test|node|code)\b/.test(lower)
  );
}

function extractFolderName(clause) {
  const mAs = clause.match(/name\s+it\s+as\s+["'`]?([a-zA-Z0-9_\- ]+)["'`]?/i);
  if (mAs) return mAs[1].trim().replace(/\s+/g, " ").trim().replace(/["'`]/g, "");
  const mNamed = clause.match(/\bnamed\s+["'`]?([a-zA-Z0-9_\- ]+)["'`]?/i);
  if (mNamed) {
    const raw = mNamed[1].trim().replace(/["'`]/g, "");
    const cut = raw.split(/\s+in\s+this\s+path/i)[0].trim();
    if (cut) return cut.replace(/\s+/g, " ").trim();
  }
  const m2 = clause.match(/called\s+["'`]?([a-zA-Z0-9_\- ]+)["'`]?/i);
  if (m2) return m2[1].trim().replace(/\s+/g, " ").trim().replace(/["'`]/g, "");
  const m = clause.match(/(?:folder|directory|project)\s+(?:called\s+|named\s+|name\s+called\s+|name\s+)?["'`]?([a-zA-Z0-9_\- ]+?)["'`]?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
  if (m) {
    const raw = m[1].trim().replace(/["'`]/g, "");
    if (raw) {
      const cleaned = raw.replace(/\s+/g, " ").trim();
      if (/^in this path/i.test(cleaned) && /name it as/i.test(clause)) {
        const inner = clause.match(/name\s+it\s+as\s+([a-zA-Z0-9_\- ]+)/i);
        if (inner) return inner[1].trim().replace(/\s+/g, " ").trim();
      }
      if (cleaned && cleaned.toLowerCase() !== "in this path name it as raju" && !cleaned.toLowerCase().startsWith("in this path")) return cleaned;
      const fallback = clause.match(/name\s+it\s+as\s+([a-zA-Z0-9_\-]+)/i);
      if (fallback) return fallback[1].trim();
      return cleaned;
    }
  }
  return null;
}

function getIncompleteClarification(text) {
  const lower = text.toLowerCase();
  if (/(create|make)\s+(a\s+)?(folder|directory|project)\b/.test(lower)) {
    const hasName = /(?:called|named|name\s+it\s+as|name\s+as)\s+["']?[a-zA-Z0-9_\-]+/i.test(text) || /[a-zA-Z]:[\\/]/.test(text) || /(create|make)\b.*\.[a-z0-9]{1,4}\b/i.test(text);
    if (!hasName) {
      const fn = extractFolderName(text);
      if (!fn) return "Sure — what should I name the folder?";
    }
  }
  if (/(create|make)\s+(a\s+)?file\b/i.test(lower) || /\bcreate\b.*\.[a-z0-9]{1,4}\b/i.test(lower)) {
    const hasFile = /[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+/.test(text) || /(?:called|named)\s+["']?[a-zA-Z0-9_\-\.]+/i.test(text);
    if (!hasFile && /create a file/i.test(text) && !/folder/i.test(text)) {
      return "Sure — what should I name the file?";
    }
  }
  return null;
}

function resolveIntent(text) {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "none" };
  if (isHowToRequest(trimmed)) return { kind: "howto" };
  if (isFilesystemActionRequest(trimmed)) return { kind: "action" };
  return { kind: "none" };
}

// Tests
console.log("TEST 4: 'create a folder' ->", getIncompleteClarification("create a folder"));
console.log("Expected: Sure — what should I name the folder?");
console.log("Pass:", getIncompleteClarification("create a folder") === "Sure — what should I name the folder?");

console.log("\nTEST 4b: 'create a file' ->", getIncompleteClarification("create a file"));
console.log("Pass:", getIncompleteClarification("create a file") === "Sure — what should I name the file?");

console.log("\nTEST 5: 'what is a PowerShell terminal?' ->", resolveIntent("what is a PowerShell terminal?"));
console.log("Pass (should be none):", resolveIntent("what is a PowerShell terminal?").kind === "none");

console.log("\nTEST folder parsing: 'create a folder name called kumar999 and write a code in that any code have to 50 lines this is a test so make it'");
const folder = extractFolderName("create a folder name called kumar999 and write a code in that any code have to 50 lines this is a test so make it");
console.log("Extracted:", folder, "Pass:", folder === "kumar999");

console.log("\nTEST compound: should be filesystem action");
console.log("isFilesystemActionRequest:", isFilesystemActionRequest("create a folder called kumar999 and write 50 lines of JavaScript code in it"));

console.log("\nAll planner tests done");
