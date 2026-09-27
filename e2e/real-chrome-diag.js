const { chromium } = require("playwright");

const SITE = "https://www.nexuss.in";
const CONNECTOR = "http://127.0.0.1:11435/health";

(async () => {
  const ctx = await chromium.launchPersistentContext(
    require("path").join(__dirname, "..", ".chrome-diag-profile"),
    {
      channel: "chrome",
      headless: false,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--no-first-run", "--no-default-browser-check"],
      viewport: { width: 1400, height: 900 },
    }
  );
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleLogs = [];
  page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLogs.push(`[pageerror] ${e.message}`));
  const failed = [];
  page.on("requestfailed", (r) =>
    failed.push(`${r.method()} ${r.url()} :: ${r.failure() && r.failure().errorText}`)
  );
  const responses = [];
  page.on("response", (r) => {
    if (r.url().includes("11435")) responses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  await page.goto(SITE, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("goto:", e.message));
  await page.waitForTimeout(2000);

  const perms = await page.evaluate(async () => {
    const out = { secureContext: window.isSecureContext, origin: location.origin, results: {} };
    const names = ["local-network-access", "local-network", "loopback-network", "private-network-access-loopback"];
    for (const n of names) {
      try {
        const r = await navigator.permissions.query({ name: n });
        out.results[n] = r.state;
      } catch (e) {
        out.results[n] = "THROWS: " + e.name + " " + e.message;
      }
    }
    return out;
  });
  console.log("=== PERMISSIONS (page load) ===");
  console.log(JSON.stringify(perms, null, 2));

  // Attempt raw connector health fetch, exactly like localTerminalRuntime does
  const probe = await page.evaluate(async () => {
    const t0 = performance.now();
    try {
      const c = new AbortController();
      const to = setTimeout(() => c.abort(), 1500);
      const res = await fetch("http://127.0.0.1:11435/health", { signal: c.signal, method: "GET", mode: "cors" });
      clearTimeout(to);
      const body = await res.json().catch(() => ({}));
      return { ok: true, status: res.status, body, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, err: String(e && e.message || e), ms: Math.round(performance.now() - t0) };
    }
  });
  console.log("=== RAW /health FETCH (1500ms timeout, no gesture) ===");
  console.log(JSON.stringify(probe, null, 2));

  await page.waitForTimeout(4000);

  const probe2 = await page.evaluate(async () => {
    const t0 = performance.now();
    try {
      const res = await fetch("http://127.0.0.1:11435/health", { method: "GET", mode: "cors" });
      const body = await res.json().catch(() => ({}));
      return { ok: true, status: res.status, body, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, err: String(e && e.message || e), ms: Math.round(performance.now() - t0) };
    }
  });
  console.log("=== RAW /health FETCH (no timeout, after 4s wait) ===");
  console.log(JSON.stringify(probe2, null, 2));

  console.log("=== CONNECTOR RESPONSES SEEN BY PAGE ===");
  console.log(responses.join("\n") || "(none)");
  console.log("=== FAILED REQUESTS ===");
  console.log(failed.filter((f) => f.includes("11435")).join("\n") || "(none)");
  console.log("=== CONSOLE (connector/permission related) ===");
  console.log(
    consoleLogs
      .filter((l) => /connector|11435|local.?network|permission|preflight|private network/i.test(l))
      .join("\n") || "(none)"
  );

  await page.screenshot({ path: require("path").join(__dirname, "..", "diag-home.png"), fullPage: false });
  await ctx.close();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
