#!/usr/bin/env node
// Fair benchmark for local models: same prompt, fixed num_predict, TTFT, total, tokens/sec
// Usage: node benchmark-local.mjs

const PROMPT = "Hello! Please respond with a short friendly greeting in one sentence.";
const NUM_PREDICT = 256;
const RUNS_PER_MODEL = 2;
const ENDPOINT = "http://127.0.0.1:11435/v1";
const DIRECT_ENDPOINT = "http://localhost:11434/v1";

const CHAT_MODELS = [
  "qwen2.5-coder:7b",
  "qwen3:4b-strix",
  "qwen3:4b",
  "hermes3:latest",
  "qwen2.5:3b",
  "phi3:latest",
  "llama3.1:8b",
  "qwen2.5-coder:1.5b-base",
  "qwen3:8b",
];

async function discoverModels() {
  try {
    const r = await fetch(`${ENDPOINT}/models`);
    if (r.ok) {
      const j = await r.json();
      const ids = (j.data || []).map(m => m.id);
      return ids.filter(id => CHAT_MODELS.includes(id) || !id.includes("embed"));
    }
  } catch {}
  try {
    const r = await fetch(`${DIRECT_ENDPOINT}/models`);
    if (r.ok) {
      const j = await r.json();
      const ids = (j.data || []).map(m => m.id);
      return ids.filter(id => CHAT_MODELS.includes(id));
    }
  } catch {}
  return CHAT_MODELS;
}

async function benchmarkModel(model, run) {
  const isCold = run === 1;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: PROMPT }],
    stream: true,
    keep_alive: "5m",
    options: { num_predict: NUM_PREDICT },
    max_tokens: NUM_PREDICT,
  });
  const t0 = performance.now();
  let ttft = null;
  let firstChunk = false;
  let totalTokens = 0;
  let text = "";
  const start = performance.now();
  let res;
  try {
    res = await fetch(`${ENDPOINT}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      // fallback to direct
      res = await fetch(`${DIRECT_ENDPOINT}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }
  } catch (e) {
    return { model, error: String(e), ttft: null, total: null, tokens: 0, tokensPerSec: 0, cold: isCold };
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    return { model, error: `HTTP ${res.status} ${txt.slice(0,200)}`, ttft: null, total: null, tokens: 0, tokensPerSec: 0, cold: isCold };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const tStart = performance.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            if (!firstChunk) {
              ttft = performance.now() - tStart;
              firstChunk = true;
            }
            text += delta;
            totalTokens += 1; // approx, will refine if usage available
          }
          if (obj.usage) {
            if (obj.usage.completion_tokens) totalTokens = obj.usage.completion_tokens;
          }
        } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const total = performance.now() - tStart;
  // Try to get real token count from final usage if available (Ollama may send usage)
  // For now use word-based approx if not provided
  const tokensPerSec = totalTokens > 0 && total > 0 ? (totalTokens / (total / 1000)) : 0;
  return { model, ttft, total, tokens: totalTokens, textLen: text.length, tokensPerSec, cold: isCold, error: null, t0: t0.toFixed(1) };
}

async function main() {
  const models = await discoverModels();
  console.log(`Discovered models: ${models.join(", ")}`);
  console.log(`Prompt: "${PROMPT}" num_predict=${NUM_PREDICT} runs=${RUNS_PER_MODEL}`);
  const results = [];
  for (const model of models) {
    if (model.includes("embed")) continue;
    for (let run = 1; run <= RUNS_PER_MODEL; run++) {
      console.log(`\n--- Benchmarking ${model} run ${run}/${RUNS_PER_MODEL} ---`);
      const r = await benchmarkModel(model, run);
      console.log(`TTFT: ${r.ttft?.toFixed(0) ?? "n/a"}ms total: ${r.total?.toFixed(0) ?? "n/a"}ms tokens: ${r.tokens} tok/s: ${r.tokensPerSec.toFixed(1)} ${r.error ? "ERR "+r.error : ""}`);
      results.push(r);
      await new Promise(res => setTimeout(res, 800));
    }
  }
  // Save results
  const out = {
    prompt: PROMPT,
    num_predict: NUM_PREDICT,
    timestamp: new Date().toISOString(),
    results,
  };
  const fs = await import('node:fs');
  fs.writeFileSync("benchmark-results.json", JSON.stringify(out, null, 2));
  let txt = `Benchmark ${new Date().toISOString()}\nPrompt: ${PROMPT}\nnum_predict=${NUM_PREDICT}\n\n`;
  txt += `MODEL | RUN | COLD | TTFT ms | TOTAL ms | TOKENS | TOK/S | TEXT LEN | ERROR\n`;
  txt += `------|-----|------|---------|----------|--------|-------|----------|-------\n`;
  for (const r of results) {
    txt += `${r.model} | ${r.cold ? "cold" : "warm"} | ${r.cold} | ${r.ttft?.toFixed(0) ?? "-"} | ${r.total?.toFixed(0) ?? "-"} | ${r.tokens} | ${r.tokensPerSec.toFixed(1)} | ${r.textLen ?? "-"} | ${r.error ?? ""}\n`;
  }
  // Aggregated per model
  txt += `\nAggregated (warm runs only):\n`;
  const byModel = {};
  for (const r of results) {
    if (!byModel[r.model]) byModel[r.model] = [];
    byModel[r.model].push(r);
  }
  for (const [m, arr] of Object.entries(byModel)) {
    const warm = arr.filter(r => !r.cold);
    const vals = warm.length ? warm : arr;
    const avgTTFT = vals.reduce((a,b)=>a+(b.ttft||0),0)/vals.length;
    const avgTotal = vals.reduce((a,b)=>a+(b.total||0),0)/vals.length;
    const avgTokS = vals.reduce((a,b)=>a+b.tokensPerSec,0)/vals.length;
    txt += `${m}: avg TTFT ${avgTTFT.toFixed(0)}ms avg total ${avgTotal.toFixed(0)}ms avg tok/s ${avgTokS.toFixed(1)}\n`;
  }
  fs.writeFileSync("benchmark-results.txt", txt);
  console.log("\n" + txt);
  console.log("\nSaved to benchmark-results.json and benchmark-results.txt");
}

main().catch(e => { console.error(e); process.exit(1); });
