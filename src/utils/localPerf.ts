// Lightweight performance instrumentation for local model path.
// Only logs in development or when NEXT_PUBLIC_PERF_DEBUG=1.
// All timestamps are performance.now() relative to user submit.

export const PERF_ENABLED = typeof process !== "undefined" ? process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_PERF_DEBUG === "1" : false;

export interface PerfMark {
  label: string;
  ts: number;
  delta?: number;
}

export class PerfTracker {
  private marks: PerfMark[] = [];
  private start: number;
  private enabled: boolean;

  constructor(enabled = PERF_ENABLED) {
    this.enabled = enabled;
    this.start = performance.now();
    this.mark("user_submit");
  }

  mark(label: string) {
    if (!this.enabled) return;
    const ts = performance.now();
    const delta = ts - this.start;
    this.marks.push({ label, ts, delta });
    // Lightweight console log for dev
    console.debug(`[Perf] ${label} +${delta.toFixed(1)}ms`);
  }

  // For TTFT, call when first chunk received
  firstToken(label = "ttft") {
    this.mark(label);
  }

  done(label = "done") {
    this.mark(label);
  }

  getMarks() {
    return this.marks;
  }

  summary() {
    if (!this.enabled || this.marks.length < 2) return null;
    const first = this.marks[0];
    const last = this.marks[this.marks.length - 1];
    const total = last.delta ?? 0;
    const ttftMark = this.marks.find((m) => m.label.includes("ttft") || m.label.includes("first_token"));
    const ttft = ttftMark?.delta ?? null;
    return { total, ttft, marks: this.marks };
  }

  logSummary() {
    if (!this.enabled) return;
    const s = this.summary();
    if (!s) return;
    console.debug(`[Perf] SUMMARY total=${s.total.toFixed(1)}ms ttft=${s.ttft?.toFixed(1) ?? "n/a"}ms marks=${s.marks.map((m) => `${m.label}:${m.delta?.toFixed(0)}`).join(" | ")}`);
  }
}

export function now() {
  return performance.now();
}
