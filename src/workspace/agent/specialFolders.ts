// Resolves Windows special folders without hardcoding username.
// Works both in Node (via process.env/os.homedir) and browser (via PowerShell env var for command).

export type SpecialFolderName = "downloads" | "desktop" | "documents" | "pictures" | "videos" | "music";

const SPECIAL_NAMES: SpecialFolderName[] = ["downloads","desktop","documents","pictures","videos","music"];

export function isSpecialFolderName(name: string): boolean {
  return SPECIAL_NAMES.includes(name.toLowerCase() as SpecialFolderName);
}

export function normalizeSpecialName(name: string): SpecialFolderName | null {
  const lower = name.trim().toLowerCase();
  if (SPECIAL_NAMES.includes(lower as any)) return lower as SpecialFolderName;
  return null;
}

// Node-side resolution to absolute fs path (e.g., C:\Users\alice\Downloads)
// Uses USERPROFILE / HOME – never hardcodes pilli. Works in browser (process.env) and Node.
// Client-safe: no Node `path` import – simple string join.
export function resolveSpecialFolderAbsolute(name: SpecialFolderName | string): string {
  const normalized = normalizeSpecialName(name);
  if (!normalized) return name;
  const home = (typeof process !== 'undefined' ? (process.env.USERPROFILE || process.env.HOME) : '') || (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '');
  const capital = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  // Windows capitalization: Downloads, Desktop etc
  const cleanHome = home.replace(/[\\/]+$/, "");
  return cleanHome ? `${cleanHome}\\${capital}` : capital;
}

// For PowerShell commands in browser, use $env:USERPROFILE to avoid hardcoding username.
// Returns PowerShell-safe string like "$env:USERPROFILE\Downloads"
export function resolveSpecialFolderForPowerShell(name: SpecialFolderName | string): string {
  const normalized = normalizeSpecialName(name);
  if (!normalized) return name;
  const capital = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  // Use $env:USERPROFILE so any Windows user works
  return `$env:USERPROFILE\\${capital}`;
}

// Extract special folder from text like "in Downloads", "on Desktop", "at Documents", "inside Pictures"
export function extractSpecialFolderFromText(text: string): { name: SpecialFolderName; basePath: string } | null {
  const m = text.match(/\b(?:in|on|at|inside|within)\s+(downloads|desktop|documents|pictures|videos|music)\b/i);
  if (m) {
    const name = m[1].toLowerCase() as SpecialFolderName;
    // Return the plain special name as basePath marker – synthesizeCommand and fallback will resolve appropriately
    // (PowerShell uses $env:USERPROFILE, Node uses homedir). Do NOT hardcode absolute here for browser.
    return { name, basePath: name };
  }
  return null;
}

// Extract absolute path OR special folder as basePath for a clause
export function extractBasePath(text: string): string | null {
  // First check absolute Windows path
  const abs = text.match(/([a-zA-Z]:\\[^\s"'`,;]+)/);
  if (abs) return abs[1].replace(/[.,;]+$/, "").trim();
  const abs2 = text.match(/([a-zA-Z]:\/[^\s"'`,;]+)/);
  if (abs2) return abs2[1].replace(/[.,;]+$/, "").trim();
  // Then special folder – return the special name marker (e.g., "Downloads") not absolute
  const special = extractSpecialFolderFromText(text);
  if (special) return special.name;
  return null;
}

// Get default user workspace when no workspacePath selected.
// Never returns repo dir (process.cwd as repo) unless homedir unavailable.
// Client-safe: avoids static `process.cwd()` reliance in browser.
export function getDefaultUserWorkspace(): string {
  const home = (typeof process !== 'undefined' ? (process.env.USERPROFILE || process.env.HOME) : '') || '';
  const cwd = (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '');
  if (home && home !== cwd) return home;
  // Fallback to cwd if homedir equals repo or unavailable – still better than repo for tests
  // For tests, cwd is repo but workspacePath is mocked, so this branch rarely used
  return home || cwd || "";
}
