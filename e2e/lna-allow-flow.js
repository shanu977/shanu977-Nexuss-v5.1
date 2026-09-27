const { chromium } = require("playwright");
const path = require("path");
const { execFileSync } = require("child_process");

const SITE = "https://www.nexuss.in";
const OUT = path.join(__dirname, "..");
const ps = (file, args) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { stdio: "pipe" }).toString();
const snap = (n) => ps(path.join(__dirname, "screen.ps1"), [path.join(OUT, n)]);

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(OUT, ".chrome-lna-profile"), {
    channel: "chrome",
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-first-run", "--no-default-browser-check", "--window-position=0,0", "--window-size=1400,900"],
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const net = [];
  page.on("request", (r) => { if (r.url().includes("11435")) net.push("REQ " + r.method() + " " + r.url()); });
  page.on("response", (r) => { if (r.url().includes("11435")) net.push("RES " + r.status() + " " + r.request().method() + " " + r.url()); });
  page.on("requestfailed", (r) => { if (r.url().includes("11435")) net.push("FAIL " + r.method() + " " + r.url() + " :: " + (r.failure() && r.failure().errorText)); });

  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => "");
    if (!/Initializing session/i.test(t)) break;
  }
  await page.waitForTimeout(2000);

  const st = async () => {
    const o = {};
    for (const n of ["local-network-access", "local-network", "loopback-network"]) {
      try { o[n] = (await page.evaluate((nn) => navigator.permissions.query({ name: nn }).then((r) => r.state), n)); } catch (e) { o[n] = "ERR"; }
    }
    return o;
  };
  console.log("perm BEFORE:", JSON.stringify(await st()));

  // ---- STEP 1: probe WITHOUT user gesture (simulates app auto health-check) ----
  await page.evaluate(() => {
    window.__p1 = fetch("http://127.0.0.1:11435/health", { method: "GET", mode: "cors" })
      .then((r) => r.json().then((b) => ({ ok: true, s: r.status, b })))
      .catch((e) => ({ ok: false, err: String(e && e.message || e) }));
  });
  await page.waitForTimeout(3000);
  await snap("lna-1-nogesture-prompt.png");
  console.log("no-gesture probe @3s:", JSON.stringify(await page.evaluate(() => Promise.race([window.__p1, Promise.resolve("PENDING")]))));

  // ---- STEP 2: click Allow on the Chrome prompt (Win32) ----
  // Prompt bubble rendered at approx (404, 271) in 1400x900 window at 0,0
  ps(path.join(__dirname, "click.ps1"), ["404", "271"]);
  await page.waitForTimeout(1500);
  await snap("lna-2-after-allow-click.png");

  const r1 = await page.evaluate(() => Promise.race([window.__p1, Promise.resolve("PENDING")]));
  console.log("no-gesture probe AFTER Allow:", JSON.stringify(r1));
  console.log("perm AFTER allow:", JSON.stringify(await st()));

  // ---- STEP 3: fresh health check, exactly like localTerminalRuntime ----
  const r2 = await page.evaluate(async () => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 1500);
      const res = await fetch("http://127.0.0.1:11435/health", { signal: c.signal, method: "GET", mode: "cors" });
      clearTimeout(t);
      const b = await res.json().catch(() => ({}));
      return { ok: true, status: res.status, terminal: b.terminal, connector: b.connector };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  });
  console.log("post-grant 1500ms health check:", JSON.stringify(r2));

  // ---- STEP 4: POST terminal/run like the app does ----
  const r3 = await page.evaluate(async () => {
    const res = await fetch("http://127.0.0.1:11435/v1/terminal/run", {
      method: "POST", mode: "cors", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo chrome-e2e-ok" }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  console.log("terminal run:", JSON.stringify(r3));

  console.log("=== 11435 network events ===\n" + net.join("\n"));
  await snap("lna-3-final.png");
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
