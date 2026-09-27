const { chromium } = require("playwright");
const path = require("path");

const SITE = "https://www.nexuss.in";

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, "..", ".chrome-diag-profile"), {
    channel: "chrome",
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-first-run", "--no-default-browser-check"],
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const responses = [];
  page.on("response", (r) => { if (r.url().includes("11435")) responses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const failed = [];
  page.on("requestfailed", (r) => { if (r.url().includes("11435")) failed.push(`${r.request().method()} ${r.url()} :: ${r.failure() && r.failure().errorText}`); });

  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  // 1) Fire-and-forget fetch with NO timeout, outside any user gesture.
  await page.evaluate(() => {
    window.__probeNoGesture = fetch("http://127.0.0.1:11435/health", { method: "GET", mode: "cors" })
      .then((r) => r.json().then((b) => ({ ok: true, status: r.status, b })))
      .catch((e) => ({ ok: false, err: String(e && e.message || e) }));
  });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(__dirname, "..", "diag-1-nogesture.png") });
  const r1 = await page.evaluate(() => Promise.race([window.__probeNoGesture, Promise.resolve("STILL_PENDING")]));
  console.log("A) fetch no-gesture no-timeout after 8s:", JSON.stringify(r1));

  // 2) Same fetch but triggered from a real trusted user gesture (click a button).
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "__gestureBtn";
    b.textContent = "probe-local-network";
    b.style.cssText = "position:fixed;top:10px;left:10px;z-index:99999;padding:10px";
    document.body.appendChild(b);
    b.addEventListener("click", () => {
      window.__probeGesture = fetch("http://127.0.0.1:11435/health", { method: "GET", mode: "cors" })
        .then((r) => r.json().then((x) => ({ ok: true, status: r.status, x })))
        .catch((e) => ({ ok: false, err: String(e && e.message || e) }));
    });
  });
  await page.click("#__gestureBtn");
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(__dirname, "..", "diag-2-gesture.png") });
  const r2 = await page.evaluate(() => Promise.race([window.__probeGesture, Promise.resolve("STILL_PENDING")]));
  console.log("B) fetch WITH user gesture after 8s:", JSON.stringify(r2));

  await page.waitForTimeout(15000);
  const r2b = await page.evaluate(() => Promise.race([window.__probeGesture, Promise.resolve("STILL_PENDING")]));
  console.log("B2) fetch WITH user gesture after 23s:", JSON.stringify(r2b));
  await page.screenshot({ path: path.join(__dirname, "..", "diag-3-final.png") });

  console.log("=== 11435 responses ===\n" + (responses.join("\n") || "(none)"));
  console.log("=== 11435 failed ===\n" + (failed.join("\n") || "(none)"));

  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
