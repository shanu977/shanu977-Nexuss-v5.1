const { chromium } = require("playwright");
const path = require("path");
const { execFileSync } = require("child_process");

const SITE = "https://www.nexuss.in";
const OUT = path.join(__dirname, "..");

function snap(name) {
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "screen.ps1"), path.join(OUT, name)], { stdio: "inherit" });
  } catch (e) { console.log("snap failed", e.message); }
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(OUT, ".chrome-diag-profile"), {
    channel: "chrome",
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-first-run", "--no-default-browser-check", "--window-position=0,0", "--window-size=1400,900"],
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const reqs = [];
  page.on("request", (r) => { if (r.url().includes("11435")) reqs.push("REQ " + r.method() + " " + r.url()); });
  page.on("response", (r) => { if (r.url().includes("11435")) reqs.push("RES " + r.status() + " " + r.request().method() + " " + r.url()); });
  page.on("requestfailed", (r) => { if (r.url().includes("11435")) reqs.push("FAIL " + r.method() + " " + r.url() + " :: " + (r.failure() && r.failure().errorText)); });

  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for app to actually finish initializing (up to 60s)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
    if (!/Initializing session/i.test(txt)) { ready = true; break; }
  }
  console.log("app ready:", ready);
  await page.waitForTimeout(3000);
  snap("shot-app-loaded.png");

  // Trigger the connector health fetch exactly like production code, from a trusted click
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "__p";
    b.textContent = "PROBE";
    b.style.cssText = "position:fixed;top:5px;left:5px;z-index:99999;padding:8px";
    document.body.appendChild(b);
    b.addEventListener("click", () => {
      window.__p = (async () => {
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 1500);
          const r = await fetch("http://127.0.0.1:11435/health", { signal: c.signal, method: "GET", mode: "cors" });
          clearTimeout(t);
          return { ok: true, status: r.status, body: await r.json().catch(() => ({})) };
        } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
      })();
    });
  });

  await page.click("#__p");
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(1500);
    snap(`shot-probe-${i}.png`);
    const v = await page.evaluate(() => Promise.race([window.__p, Promise.resolve("PENDING")]));
    console.log(`t+${i * 1.5}s =>`, JSON.stringify(v));
    if (v !== "PENDING") break;
  }

  console.log("=== 11435 network events ===\n" + (reqs.join("\n") || "(NONE)"));

  // After that, check permission states again
  const perms = await page.evaluate(async () => {
    const o = {};
    for (const n of ["local-network-access", "local-network", "loopback-network"]) {
      try { o[n] = (await navigator.permissions.query({ name: n })).state; } catch (e) { o[n] = "ERR " + e.name; }
    }
    return o;
  });
  console.log("=== permission states after probe ===", JSON.stringify(perms));

  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
