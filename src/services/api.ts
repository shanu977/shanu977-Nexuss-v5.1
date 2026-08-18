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