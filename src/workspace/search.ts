// Hybrid search over the workspace index.
//
// Exact, dependency-free matching (no embeddings in v1): filename/path matches,
// symbol matches, and content substring matches are scored and ranked. Explicit
// files mentioned in the query and error-text matches are boosted because they
// are the highest-signal retrieval hints.

import type {
  IndexedFile,
  SearchHit,
  WorkspaceIndex,
  WorkspaceSearchOptions
} from "./types";

export function tokenize(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9_]+/g)?.filter((t) => t.length > 1) ?? [];
}

/** Files whose filename (with extension) literally appears in the query. */
export function findMentionedFiles(
  index: WorkspaceIndex,
  query: string
): IndexedFile[] {
  const q = query.toLowerCase();
  return index.files.filter(
    (f) => f.name.length > 4 && q.includes(f.name.toLowerCase())
  );
}

export function searchIndex(
  index: WorkspaceIndex,
  query: string,
  options: WorkspaceSearchOptions = {}
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = tokenize(q);
  const explicitFiles = new Set(options.explicitFiles ?? []);
  const explicitSymbols = new Set(options.explicitSymbols ?? []);
  const errorText = options.errorText?.toLowerCase();
  const hits: SearchHit[] = [];

  for (const file of index.files) {
    const reasons: string[] = [];
    let score = 0;
    const nameLower = file.name.toLowerCase();
    const pathLower = file.path.toLowerCase();

    if (explicitFiles.size > 0 && explicitFiles.has(file.path)) {
      score += 100;
      reasons.push("explicitly mentioned");
    }
    if (explicitSymbols.size > 0 && explicitSymbols.has(file.name)) {
      score += 40;
      reasons.push("named symbol");
    }

    for (const tok of tokens) {
      if (nameLower.includes(tok)) {
        score += 12;
        reasons.push("filename match");
      } else if (pathLower.includes(tok)) {
        score += 6;
        reasons.push("path match");
      }
    }

    if (file.symbols.some((s) => tokens.some((t) => s.toLowerCase().includes(t)))) {
      score += 18;
      reasons.push("symbol match");
    }

    if (errorText && file.chunks.some((c) => c.toLowerCase().includes(errorText))) {
      score += 30;
      reasons.push("error text found");
    }

    if (file.chunks.length > 0) {
      const matched = tokens.filter((t) =>
        file.chunks.some((c) => c.toLowerCase().includes(t))
      );
      if (matched.length > 0) {
        score += Math.min(10 * matched.length, 40);
        reasons.push(
          matched.length === tokens.length ? "exact content match" : "content match"
        );
      }
    }

    // Recency is only a tie-breaker: it must never make an otherwise
    // non-matching file appear relevant.
    if (score > 0 && file.mtime > 0) {
      score += Math.min(Math.log(Date.now() - file.mtime + 1) / 12, 2);
    }

    if (score > 0) hits.push({ file, score, reasons });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 25);
}