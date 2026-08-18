import { auth } from "@/lib/firebase";

const BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/$/, "");

export class ApiError extends Error {
  status: number;

  attempts?: {
    provider: string;
    model: string;
    attempt: number;
    status: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    response_time_ms: number;
    http_status?: number | null;
    reason?: string | null;
    timestamp: number;
  }[];

  constructor(
    status: number,
    message: string,
    attempts?: ApiError["attempts"]
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.attempts = attempts;
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const currentUser = auth.currentUser;

    if (currentUser) {
      const token = await currentUser.getIdToken();
      headers["Authorization"] = `Bearer ${token}`;
    }
  } catch (err) {
    console.error("Failed to retrieve auth token:", err);
  }

  return headers;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Maximum time without a single byte from a streaming response before it is
// considered dead and aborted (a provider that stalls mid-answer is useless).
const STALL_TIMEOUT_MS = 30_000;

export async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  const defaultHeaders = await getAuthHeaders();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
  } catch {
    if (controller.signal.aborted) {
      throw new ApiError(0, "The request timed out. Please try again.");
    }
    throw new ApiError(0, "Network error. Check your connection.");
  }

  try {
    if (!res.ok) {
      let detail = res.statusText || `Request failed (${res.status})`;
      let attempts: ApiError["attempts"];

      try {
        const body = await res.json();

        if (body && typeof body.detail === "string") {
          detail = body.detail;
        } else if (
          body &&
          Array.isArray(body.detail) &&
          body.detail.length > 0
        ) {
          const first = body.detail[0];
          detail = first?.msg || first?.message || detail;
        }

        if (body && Array.isArray(body.attempts)) {
          attempts = body.attempts;
        }
      } catch {
        // Ignore JSON parsing errors.
      }

      throw new ApiError(res.status, detail, attempts);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

/**
 * Fetch a Server-Sent Events (SSE) endpoint and yield one parsed event per
 * `data:` payload. Non-ok responses (validation/auth errors that happen before
 * streaming starts) are surfaced as a normal `ApiError` with the backend
 * detail and attempt log. Once streaming has started the HTTP status is fixed,
 * so mid-stream provider failures arrive as SSE `error` events instead.
 *
 * Two safety deadlines, mirroring the backend chain deadline:
 *  - overall: DEFAULT_TIMEOUT_MS (same as `request`)
 *  - per-chunk stall: STALL_TIMEOUT_MS with no bytes at all
 * Either one aborts the request and rejects with a timeout `ApiError`.
 */
export async function* requestStream<T>(
  path: string,
  options: RequestInit = {}
): AsyncGenerator<T> {
  const controller = new AbortController();
  const overallTimeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  const defaultHeaders = await getAuthHeaders();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
  } catch {
    if (controller.signal.aborted) {
      throw new ApiError(0, "The request timed out. Please try again.");
    }
    throw new ApiError(0, "Network error. Check your connection.");
  }

  if (!res.ok) {
    let detail = res.statusText || `Request failed (${res.status})`;
    let attempts: ApiError["attempts"];

    try {
      const body = await res.json();

      if (body && typeof body.detail === "string") {
        detail = body.detail;
      } else if (
        body &&
        Array.isArray(body.detail) &&
        body.detail.length > 0
      ) {
        const first = body.detail[0];
        detail = first?.msg || first?.message || detail;
      }

      if (body && Array.isArray(body.attempts)) {
        attempts = body.attempts;
      }
    } catch {
      // Ignore JSON parsing errors.
    }

    throw new ApiError(res.status, detail, attempts);
  }

  if (!res.body) {
    throw new ApiError(0, "Streaming is not supported by this browser.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stallTimeout: ReturnType<typeof setTimeout> | null = null;

  const armStall = () => {
    if (stallTimeout) clearTimeout(stallTimeout);
    stallTimeout = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };
  const disarmStall = () => {
    if (stallTimeout) {
      clearTimeout(stallTimeout);
      stallTimeout = null;
    }
  };

  const extractEvents = (text: string): [string, T[]] => {
    // Server-sent events are separated by a blank line; each `data:` line
    // carries one JSON payload (single-line, so no multi-line splitting here).
    const events: T[] = [];
    let idx: number;
    while ((idx = text.indexOf("\n\n")) !== -1) {
      const block = text.slice(0, idx);
      text = text.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        events.push(JSON.parse(dataLine.slice(5).trim()) as T);
      } catch {
        // Ignore malformed events (e.g. partial JSON keep-alives).
      }
    }
    return [text, events];
  };

  try {
    while (true) {
      armStall();
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ done, value } = await reader.read());
      } finally {
        disarmStall();
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const [rest, events] = extractEvents(buffer);
      buffer = rest;
      for (const event of events) {
        yield event;
      }
    }
    buffer += decoder.decode();
    const [, events] = extractEvents(buffer);
    for (const event of events) {
      yield event;
    }
  } catch {
    if (controller.signal.aborted) {
      throw new ApiError(0, "The request timed out. Please try again.");
    }
    throw new ApiError(0, "The connection was interrupted.");
  } finally {
    clearTimeout(overallTimeout);
    disarmStall();
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}