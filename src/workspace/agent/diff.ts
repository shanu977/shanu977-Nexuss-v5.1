// Pure unified-diff generator for the workspace agent approval UI.
//
// Line-oriented with a single hunk per change run (no interleaved context).
// Large files degrade gracefully to a whole-file replacement diff instead of
// consuming unbounded memory. Fully synchronous and dependency-free.

type DiffOp =
  | { type: "eq"; text: string }
  | { type: "del"; text: string }
  | { type: "add"; text: string };

const MAX_DIFF_LINES = 4000;
const MAX_DP_CELLS = 2_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // A single trailing newline is a line terminator, not an extra empty line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Minimal LCS-based line diff (longest common subsequence via DP). Returns the
 * operation list describing how `a` becomes `b`. Falls back to a whole-replace
 * when the DP matrix would be too large to be safe.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DP_CELLS || n + m > MAX_DIFF_LINES) {
    return [
      ...a.map((text): DiffOp => ({ type: "del", text })),
      ...b.map((text): DiffOp => ({ type: "add", text }))
    ];
  }

  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j] });
    j++;
  }
  return ops;
}

/**
 * Renders a unified diff between `before` and `after` for the given relative
 * path. Returns "" when there is nothing to change.
 */
export function createUnifiedDiff(
  path: string,
  before: string,
  after: string
): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);

  let oldLine = 1;
  let newLine = 1;
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "eq") {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    const startOld = oldLine;
    const startNew = newLine;
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < ops.length && ops[i].type !== "eq") {
      const op = ops[i];
      if (op.type === "del") {
        lines.push(`-${op.text}`);
        oldLine++;
        oldCount++;
      } else {
        lines.push(`+${op.text}`);
        newLine++;
        newCount++;
      }
      i++;
    }
    hunks.push(
      `@@ -${startOld},${oldCount} +${startNew},${newCount} @@`,
      ...lines
    );
  }

  if (hunks.length === 0) return "";
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}