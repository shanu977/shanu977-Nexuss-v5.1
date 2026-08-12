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

export async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  let res: Response;

  const defaultHeaders = await getAuthHeaders();

  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
  } catch {
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

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}