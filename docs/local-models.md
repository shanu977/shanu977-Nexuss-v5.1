# Nexuss Local Models

Run AI models on your own computer and chat with them in Nexuss without cloud API keys. Nexuss connects directly from your browser to an OpenAI-compatible local endpoint (no backend proxy, no data leaves your device).

## Supported Servers

- **Ollama** – `http://localhost:11434/v1` (default)
- **LM Studio** – `http://localhost:1234/v1`
- **vLLM** – `http://localhost:8000/v1`
- **Generic OpenAI-compatible** – any `http://localhost:PORT/v1`

Architecture is extensible: add any OpenAI-compatible server by entering its URL.

## Quick Setup

### Ollama

1. Install from https://ollama.com
2. Pull a model: `ollama pull llama3.2:3b` or `ollama pull qwen2.5:7b`
3. Allow CORS for the browser (required for both local dev and production):
   ```bash
   # Explicit allowlist (recommended):
   OLLAMA_ORIGINS=https://www.nexuss.in,https://nexuss.in,http://localhost:3000,http://localhost:3001 ollama serve
   # or on Windows: set OLLAMA_ORIGINS=https://www.nexuss.in,https://nexuss.in,http://localhost:3000 && ollama serve
   # For quick test, allow all (less secure):
   # OLLAMA_ORIGINS=* ollama serve
   ```
   For `https://www.nexuss.in` → `http://localhost:11434` the browser requires Private Network Access. Ollama 0.33+ handles `Access-Control-Allow-Private-Network: true` when `OLLAMA_ORIGINS` allows the origin. If direct `https` → `http://localhost` is still blocked, use the lightweight **Nexuss Local Connector** (see below).
4. In Nexuss: Settings → Models → + Add Local Model → Provider Ollama → Endpoint `http://localhost:11434/v1` → Test Connection → Select model → Add Model
5. Select `Local • llama3.2:3b` in the composer model selector and chat. No Groq/Gemini/OpenRouter key needed.

#### Nexuss Local Connector (for https://www.nexuss.in)

Production `https://www.nexuss.in` (public) → `http://localhost:11434` (private) requires PNA and correct CORS. If Ollama alone does not handle it, run the lightweight connector that binds only to loopback and proxies with correct headers:

```bash
# From the Nexuss project root
npm run connector
# or: node local-connector/server.js
# Listens on http://127.0.0.1:11435, forwards only to Ollama on 127.0.0.1:11434, allows only Nexuss origins
```

Nexuss Web will automatically detect the connector at `http://127.0.0.1:11435` for Ollama (`http://localhost:11434/v1` → `http://127.0.0.1:11435/v1`) and use it for both `GET /v1/models` and `POST /v1/chat/completions`. Keep it running while using local models from `https://www.nexuss.in`. No cloud proxy, no SSRF, binds only to `127.0.0.1`, validates `localhost` only, and rejects `169.254.169.254`.

### LM Studio

1. Download LM Studio, load a model (e.g., Qwen 2.5 7B)
2. Start Server → set Port 1234 → enable CORS → Start
3. Add `http://localhost:1234/v1` in Nexuss.

### vLLM

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000 --served-model-name qwen2.5:7b
```
Add `http://localhost:8000/v1`.

### Generic

Enter any OpenAI-compatible base URL ending in `/v1`. If `/models` is unavailable, enter the model ID manually.

## Settings UI

`Settings → Models → Local Models`

- Each endpoint shows: name (Ollama/LM Studio/vLLM), URL, enabled status, and its models.
- Actions per endpoint: **Test** (real connectivity + `/models` discovery), **Edit**, **Remove**.
- Adding: choose provider type, endpoint, optional API key, **Test Connection**, pick discovered models or enter manual ID, **Add Model**.
- Models can be enabled/disabled or removed without deleting chat history.

Endpoint normalization: `http://localhost:11434` → `http://localhost:11434/v1` for Ollama; trailing slashes and `/v1/models` or `/v1/chat/completions` are stripped to base `/v1`.

## Model Discovery

`GET {endpoint}/models` (OpenAI-compatible). Example: `http://localhost:11434/v1/models` → `{data:[{id:"llama3.2:3b"}]}`.

- On success: show discovered models for selection.
- On 404/405 or empty: show “Endpoint reachable, discovery unavailable — enter model ID manually.”
- On 401: prompt for API key.
- On network/CORS failure: “Check that server is running and allows CORS. For Ollama, set OLLAMA_ORIGINS=*.”

## Chat Integration & Streaming

Local models appear in the same model selector as cloud models:

- **Local** section (on-device, no API key) listed first.
- **Groq / Gemini / OpenRouter** sections follow.

Selecting a local model routes chat **directly from the browser** to the local endpoint:

```
User message → Nexuss builds OpenAI messages (system + workspace context + history) → POST {endpoint}/chat/completions {model, messages, stream:true} → streaming SSE → ReasoningFilter → UI
```

Streaming reuses the same `ReasoningFilter` and `MessageList` as cloud, so the UX (thinking indicator, incremental tokens, blinking cursor) is identical. `streamLocalChat` in `src/services/localModels.ts` handles OpenAI SSE (`data: {...}` with `choices[0].delta.content`).

Workspace context (Path) is included as a `system` message for local, same as cloud (attached server-side for cloud, client-side for local).

## Connection Test & Health

Test performs real `GET /models`. Status:

- **Connected** – endpoint reachable, models listed.
- **Endpoint reachable, discovery unavailable** – server works but `/models` not supported.
- **Not connected** – timeout (8s), connection refused, CORS, or 4xx/5xx with user-friendly message.

No continuous polling. Health is checked on **Test** or before chat; if the server later goes down, chat shows “Cannot connect…” with guidance.

## Error Handling

User-friendly messages, no stack traces:

- Ollama/LM Studio/vLLM not running → “Cannot connect… Is the server running? Check port and CORS.”
- Wrong port / invalid URL → validation error.
- Model not found (404) → “Model not found. Check model ID and that `ollama pull` succeeded.”
- 401 → “Authentication failed. Check API key.”
- CORS → “Failed to fetch / CORS. For Ollama, set OLLAMA_ORIGINS=*.”
- Timeout, malformed data, unsupported streaming → appropriate retrieval.

## Security & Browser Networking (Production)

**Browser-direct, not cloud proxy.** Local endpoints are at `localhost` / `127.0.0.1` / `::1`. The cloud backend (`https://shanu977-nexuss-v51-production.up.railway.app`) cannot reach your laptop’s `localhost:11434`, so proxying would fail and would be SSRF (fetching `169.254.169.254`). Nexuss therefore fetches local models **only from the browser** (or via the local connector below).

- Frontend validates URL (`http://`/`https://`, not `169.254.169.254` or `*.internal`).
- No SSRF via backend: local requests never go through `/chat` or any `/api/proxy?url=http://localhost`.
- Connector (if used) binds only to `127.0.0.1:11435`, allows only `https://www.nexuss.in,https://nexuss.in,http://localhost:3000` etc., and only proxies to `127.0.0.1:11434` (`/v1/models`, `/v1/chat/completions`, `/api/tags`). It rejects `169.254.169.254`, `0.0.0.0`, private ranges, and arbitrary URLs.
- API keys for local endpoints (if needed) are stored per-user in IndexedDB (Dexie) alongside `localProviders`, never logged, never sent to cloud.
- User isolation: all Dexie queries are `where("userId").equals(uid)`; desktop IPC also validates `localhost` only.

**CORS & Private Network Access (PNA):** `https://www.nexuss.in` (public) → `http://localhost:11434` (private/loopback) is a **private network request**. Browser sends `OPTIONS` with `Origin: https://www.nexuss.in` + `Access-Control-Request-Private-Network: true`. Server must reply `Access-Control-Allow-Origin: https://www.nexuss.in` + `Access-Control-Allow-Private-Network: true`. Ollama does this when `OLLAMA_ORIGINS` includes the origin. For `http://localhost:3000` → `http://localhost:11434` (same private), PNA not required and `http://localhost:3000` already works.

- Ollama: `OLLAMA_ORIGINS=https://www.nexuss.in,https://nexuss.in,http://localhost:3000` (explicit allowlist, not `*` unless needed). Restart `ollama serve`.
- If `https` → `http://localhost` is still blocked (browser mixed-content/PNA even with CORS), use the **Nexuss Local Connector** (`http://127.0.0.1:11435`) which is `http` loopback but correctly handles PNA for `https://www.nexuss.in` (sends `Allow-Private-Network: true`). Nexuss Web auto-detects `http://127.0.0.1:11435/health` and uses it for Ollama `http://localhost:11434/v1`.
- LM Studio: enable CORS in server settings. vLLM: `--enable-cors-allow-origins https://www.nexuss.in --enable-cors-allow-private-network`.
- Mixed content: `http://localhost` is *potentially trustworthy* and exempt from mixed-content blocking when fetched from `https`, so direct `https`→`http://localhost` is allowed if CORS/PNA pass.

**Why no cloud proxy:** `https://www.nexuss.in` cannot fetch user's `localhost` via the cloud—`localhost` on the server is the server's own loopback, not the user's PC, and would let one user access another's if it were a generic proxy. Hence browser-direct (or local connector) is the only correct, user-isolated path.

## API Key Handling

- Local `API Key` is **optional** (Ollama usually none; some vLLM/generic servers require it).
- Stored in IndexedDB per user, per provider, alongside endpoint (Dexie `localProviders.apiKey`).
- Never exposed in logs or UI; `Authorization: Bearer <key>` only added if present.

## Model Selector & Persistence

- `useLocalModelStore` (Zustand) persists to Dexie `localProviders`/`localModels` tables (IndexedDB, per `userId`). Added in `db.ts` version 5 (`[providerId+modelId]`, `[userId+enabled]` indexes).
- `useChatStore` stores `provider`/`model` in `localStorage` (device-local) and reconciles with `localModelStore`. Selecting `Local` shows enabled local models; selecting a local model sets `provider="local"`, `model=modelId`. If endpoint becomes unavailable, selector still shows the model but chat will show a clear error instead of silently switching to cloud.

## Management

- **Add:** endpoint → Test → discover or manual ID → Add Model
- **Enable/disable:** toggle per model (kept but hidden from selector when disabled)
- **Edit:** change name/endpoint per provider (re-normalized)
- **Remove:** per model or per provider (cascades to its models; never deletes chat history or `db.messages`/`db.chats`)

## Cost & Usage

Local inference is on-device; Nexuss does **not** count it toward cloud token usage or cost. `useUsageStore` is not incremented for local streams. If you open Usage, local requests appear as `Provider: Local, Cost: $0` only if you explicitly record; by default they are untracked to avoid fake cloud accounting. No artificial token limit for local.

## Hardware Limitations

Local models run on your CPU/GPU/RAM. Performance depends on your machine. Large models (7B+ Qwen, Llama) need 8–16GB RAM and may be slow on CPU-only. Start with `llama3.2:3b` or `qwen2.5:1.5b` for testing.

## Privacy

- Chats with local models still store messages in IndexedDB per your existing Nexuss retention (user-isolated), but **no prompt, history, or API key is sent to any cloud provider**.
- Workspace context (Path) for local is built client-side and sent only to your localhost endpoint.
- No backend logging of local prompts.

## Troubleshooting

- **Test shows “Cannot connect”** → `curl http://localhost:11434/v1/models` should return JSON. If not, server not running or wrong port. For CORS, check browser console: `No 'Access-Control-Allow-Origin'` means set `OLLAMA_ORIGINS=*`.
- **Model not found** → `ollama list` or LM Studio model list; ensure ID matches exactly (`llama3.2:3b` not `llama3.2`).
- **Streaming stalls** → ensure server supports `stream:true`; try non-streaming `curl -X POST .../chat/completions -d '{"model":"...","messages":[{"role":"user","content":"hi"}]}'`.

## Testing

See `src/store/localModelStore.test.ts`, `src/services/localModels.test.ts`, `src/store/localChat.test.ts` for 20+ cases: add/validate/test/discovery success/failure/manual entry, enable/disable, edit/remove, user isolation, selector, local streaming, cloud still works, error paths.

Run: `npm run test -- src/store/localModelStore.test.ts src/services/localModels.test.ts src/store/localChat.test.ts`
