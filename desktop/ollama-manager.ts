import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { getSystemInfo } from "./system-info";

const execFileAsync = promisify(execFile);

export type OllamaStatus =
  | "checking"
  | "not_installed"
  | "starting"
  | "running"
  | "error";

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
}

export interface OllamaState {
  status: OllamaStatus;
  message: string;
  installed: boolean;
  running: boolean;
  version?: string;
  endpoint: string;
  models?: OllamaModel[];
}

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const OLLAMA_ENDPOINT = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;

let ollamaProcess: ChildProcess | null = null;

const execFileAsyncOptions = {
  timeout: 5000,
  windowsHide: true
};

async function getOllamaVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "ollama",
      ["--version"],
      execFileAsyncOptions
    );

    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(3000)
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function getOllamaModels(): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      models?: Array<{
        name?: string;
        size?: number;
        modified_at?: string;
        details?: {
          family?: string;
          parameter_size?: string;
          quantization_level?: string;
        };
      }>;
    };

    if (!Array.isArray(data.models)) {
      return [];
    }

    return data.models
      .filter((model) => typeof model.name === "string" && model.name.trim())
      .map((model) => ({
        name: model.name as string,
        size: model.size,
        modifiedAt: model.modified_at,
        family: model.details?.family,
        parameterSize: model.details?.parameter_size,
        quantization: model.details?.quantization_level
      }));
  } catch {
    return [];
  }
}

async function startOllamaProcess(): Promise<void> {
  if (ollamaProcess && ollamaProcess.exitCode === null) {
    return;
  }

  ollamaProcess = spawn("ollama", ["serve"], {
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  ollamaProcess.stdout?.on("data", (data) => {
    console.log(`[ollama] ${String(data).trimEnd()}`);
  });

  ollamaProcess.stderr?.on("data", (data) => {
    console.error(`[ollama] ${String(data).trimEnd()}`);
  });

  ollamaProcess.on("exit", () => {
    ollamaProcess = null;
  });
}

async function waitForOllama(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isOllamaRunning()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

export async function getOllamaState(): Promise<OllamaState> {
  const version = await getOllamaVersion();

  if (!version) {
    return {
      status: "not_installed",
      message: "Ollama is not installed.",
      installed: false,
      running: false,
      endpoint: OLLAMA_ENDPOINT
    };
  }

  if (await isOllamaRunning()) {
    const models = await getOllamaModels();

    return {
      status: "running",
      message:
        models.length > 0
          ? `Ollama is running. Found ${models.length} local model${models.length === 1 ? "" : "s"}.`
          : "Ollama is running, but no local models are installed.",
      installed: true,
      running: true,
      version,
      endpoint: OLLAMA_ENDPOINT,
      models
    };
  }

  return {
    status: "checking",
    message: "Ollama is installed but not running.",
    installed: true,
    running: false,
    version,
    endpoint: OLLAMA_ENDPOINT,
    models: []
  };
}

export async function ensureOllamaRunning(): Promise<OllamaState> {
  const version = await getOllamaVersion();

  if (!version) {
    return {
      status: "not_installed",
      message: "Ollama is not installed. Please install Ollama first.",
      installed: false,
      running: false,
      endpoint: OLLAMA_ENDPOINT
    };
  }

  if (await isOllamaRunning()) {
    const models = await getOllamaModels();

    return {
      status: "running",
      message:
        models.length > 0
          ? `Local AI server ready. Found ${models.length} local model${models.length === 1 ? "" : "s"}.`
          : "Local AI server ready. No local models are installed.",
      installed: true,
      running: true,
      version,
      endpoint: OLLAMA_ENDPOINT,
      models
    };
  }

  try {
    await startOllamaProcess();

    const ready = await waitForOllama();

    if (!ready) {
      return {
        status: "error",
        message: "Ollama was installed but the local server could not be started.",
        installed: true,
        running: false,
        version,
        endpoint: OLLAMA_ENDPOINT,
        models: []
      };
    }

    const models = await getOllamaModels();

    return {
      status: "running",
      message:
        models.length > 0
          ? `Local AI server ready. Found ${models.length} local model${models.length === 1 ? "" : "s"}.`
          : "Local AI server ready. No local models are installed.",
      installed: true,
      running: true,
      version,
      endpoint: OLLAMA_ENDPOINT,
      models
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to start Ollama: ${
        error instanceof Error ? error.message : String(error)
      }`,
      installed: true,
      running: false,
      version,
      endpoint: OLLAMA_ENDPOINT,
      models: []
    };
  }
}

export async function discoverOllamaModels(): Promise<OllamaModel[]> {
  const running = await isOllamaRunning();

  if (!running) {
    return [];
  }

  return getOllamaModels();
}


export interface OllamaModelRecommendation {
  model: string;
  reason: string;
  suitable: boolean;
}

export async function recommendOllamaModel(): Promise<{
  system: Awaited<ReturnType<typeof getSystemInfo>>;
  recommendations: OllamaModelRecommendation[];
}> {
  const system = await getSystemInfo();
  const recommendations: OllamaModelRecommendation[] = [];
  const ramGB = system.memory.totalGB;

  if (ramGB >= 16) {
    recommendations.push(
      {
        model: "qwen2.5-coder:7b",
        reason: "Suitable for coding and general development on systems with 16 GB or more RAM.",
        suitable: true
      },
      {
        model: "llama3.2:3b",
        reason: "Lightweight general-purpose model with lower resource requirements.",
        suitable: true
      }
    );
  } else if (ramGB >= 8) {
    recommendations.push(
      {
        model: "llama3.2:3b",
        reason: "A lightweight model suitable for systems with around 8 GB RAM.",
        suitable: true
      },
      {
        model: "qwen2.5-coder:3b",
        reason: "A smaller coding-focused model intended for lower-resource systems.",
        suitable: true
      }
    );
  } else {
    recommendations.push({
      model: "llama3.2:1b",
      reason: "A smaller model is recommended because the system has limited RAM.",
      suitable: true
    });
  }

  return {
    system,
    recommendations
  };
}
export function stopOllama(): void {
  if (ollamaProcess && ollamaProcess.exitCode === null) {
    ollamaProcess.kill();
    ollamaProcess = null;
  }
}

export { OLLAMA_ENDPOINT };
export interface OllamaPullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<OllamaModel> {
  const modelName = model.trim();

  if (!modelName) {
    throw new Error("A model name is required.");
  }

  if (!(await isOllamaRunning())) {
    throw new Error(
      "Ollama is not running. Start the local AI server before downloading a model."
    );
  }

  const response = await fetch(`${OLLAMA_ENDPOINT}/api/pull`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: modelName,
      stream: true
    }),
    signal: AbortSignal.timeout(30 * 60 * 1000)
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Model download failed (${response.status})${details ? `: ${details}` : "."}`
    );
  }

  if (!response.body) {
    throw new Error("Ollama did not provide a download progress stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) continue;

        let event: {
          status?: string;
          completed?: number;
          total?: number;
          error?: string;
        };

        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (event.error) {
          throw new Error(`Ollama model download failed: ${event.error}`);
        }

        const progress: OllamaPullProgress = {
          model: modelName,
          status: event.status ?? "Downloading model...",
          completed: event.completed,
          total: event.total,
          percent:
            typeof event.completed === "number" &&
            typeof event.total === "number" &&
            event.total > 0
              ? Number(((event.completed / event.total) * 100).toFixed(1))
              : undefined
        };

        onProgress?.(progress);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const models = await getOllamaModels();
  const installed = models.find(
    (installedModel) => installedModel.name === modelName
  );

  if (!installed) {
    throw new Error(
      `Model download completed, but Ollama could not verify model "${modelName}".`
    );
  }

  onProgress?.({
    model: modelName,
    status: "Model download complete.",
    percent: 100
  });

  return installed;
}
