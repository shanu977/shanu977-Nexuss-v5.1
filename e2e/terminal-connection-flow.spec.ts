// Focused E2E for the one-click Terminal connection flow, run against the
// REAL local connector (node local-connector/server.js on 127.0.0.1:11435).
// Chat responses are SSE-mocked so tests are deterministic; terminal health
// checks and command execution are real.
//
// Scenarios: one-click connect, real chat-driven command execution, disconnect
// honesty (no execution / no fake connected status), connector unavailable,
// heartbeat connection loss, retry, browser local-network permission denial,
// and normal AI chat working independently of the terminal.

import os from 'node:os';
import { test, expect } from '@playwright/test';

const CONNECTOR = 'http://127.0.0.1:11435';
// With no workspace folder picked in a fresh session, the deterministic
// planner targets the real user home (connector-side $env:USERPROFILE).
const HOME = os.homedir();
const UID = `nexuss_flow_${Date.now()}`;

async function term(cmd: string) {
  const r = await fetch(`${CONNECTOR}/v1/terminal/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: cmd })
  });
  return r.json();
}
async function exists(p: string) {
  const r = await term(`powershell -NoProfile -Command "Test-Path -LiteralPath '${p}'"`);
  return r.stdout.trim() === 'True';
}
async function cleanup(paths: string[]) {
  for (const p of paths) {
    if (await exists(p)) await term(`powershell -NoProfile -Command "Remove-Item -LiteralPath '${p}' -Recurse -Force"`);
  }
}
function sseMock(content: string) {
  return `data: ${JSON.stringify({ type: 'chunk', content })}\n\ndata: ${JSON.stringify({ type: 'usage', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, provider: 'groq', model: 'llama-3.3-70b-versatile', fallback_used: null, attempts: [] })}\n\n`;
}
async function mockChat(page: any, content = 'ok') {
  await page.route('**/chat/stream', async (route: any) => {
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sseMock(content) });
  });
  await page.route('**/chat', async (route: any) => {
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sseMock(content) });
  });
}
async function gotoApp(page: any) {
  await page.addInitScript(() => { (window as any).__NEXUSS_E2E_BYPASS = true; });
  await mockChat(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
}
async function openTerminalPanel(page: any) {
  const sectionLoc = page.locator('section[aria-label="Terminal workspace"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    const plus = page.getByRole('button', { name: 'Add attachment' });
    await plus.waitFor({ state: 'visible', timeout: 10000 });
    await plus.click();
    const termBtn = page.getByRole('menuitem', { name: 'Terminal' });
    await termBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await termBtn.isVisible().catch(() => false)) {
      if ((await termBtn.getAttribute('aria-pressed')) !== 'true') await termBtn.click();
      else await page.keyboard.press('Escape');
    } else {
      await page.keyboard.press('Escape');
      continue;
    }
    try {
      await expect(sectionLoc).toBeVisible({ timeout: 8000 });
      return;
    } catch {
      await page.keyboard.press('Escape');
    }
  }
  throw new Error('terminal panel did not open');
}
async function send(page: any, text: string) {
  await page.getByLabel('Message input').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(7000);
}
const section = (page: any) => page.locator('section[aria-label="Terminal workspace"]');

test.beforeAll(async () => {
  const r = await fetch(`${CONNECTOR}/health`);
  if (!r.ok) throw new Error('connector down — start it with: npm run connector');
  const body = await r.json() as { protocol?: number };
  if (typeof body.protocol !== 'number') {
    throw new Error('connector is stale — restart it so /health reports the protocol field');
  }
});

test.describe.serial('terminal connection flow (real connector)', () => {
  test('one-click Connect Terminal verifies the real connector and shows connected UI', async ({ page }) => {
    await gotoApp(page);
    await openTerminalPanel(page);
    // Fresh session (no passive auto-connect yet): the connect screen is shown.
    // The passive check may auto-connect if the connector is already running —
    // both paths must end at the verified connected UI, never a fake state.
    const s = section(page);
    const connectBtn = s.getByRole('button', { name: 'Connect Terminal' });
    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click();
    }
    await expect(s.getByText('Terminal Connected')).toBeVisible({ timeout: 15000 });
    await expect(s.getByRole('status')).toHaveAttribute('aria-label', 'Terminal connected');
    // Green status only after real verification: header dot uses emerald.
    await expect(s.locator('.bg-emerald-500').first()).toBeVisible();
    // Session-disconnect must be available and the connected copy shown.
    await expect(s.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  test('real command execution through chat: creates a real folder on disk', async ({ page }) => {
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    const connectBtn = s.getByRole('button', { name: 'Connect Terminal' });
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click();
    await expect(s.getByText('Terminal Connected')).toBeVisible({ timeout: 15000 });

    const folder = `${HOME}\\${UID}`;
    await cleanup([folder]);
    await send(page, `create a folder name called ${UID}`);
    // Real filesystem truth via the real connector — not UI text.
    expect(await exists(folder)).toBe(true);
    // The UI must report honest success with the real path.
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain("couldn't complete");
    expect(body).toContain(UID.toLowerCase());
    await cleanup([folder]);
  });

  test('disconnect is honest: chat action is refused, nothing executes, no fake connected status', async ({ page }) => {
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    const connectBtn = s.getByRole('button', { name: 'Connect Terminal' });
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click();
    await expect(s.getByText('Terminal Connected')).toBeVisible({ timeout: 15000 });

    await s.getByRole('button', { name: 'Disconnect' }).click();
    await expect(s.getByRole('button', { name: 'Connect Terminal' })).toBeVisible({ timeout: 10000 });
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
    await expect(s.getByRole('status')).toHaveAttribute('aria-label', 'Terminal disconnected');

    const folder = `${HOME}\\${UID}_disc`;
    await cleanup([folder]);
    await send(page, `create a folder name called ${UID}_disc`);
    // Nothing may be created while disconnected.
    expect(await exists(folder)).toBe(false);
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).toContain('terminal');
    // And the panel must not claim to be connected.
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
    await cleanup([folder]);
  });

  test('connection loss is detected by heartbeat; recovery runs, then retry reconnects', async ({ page }) => {
    // Heartbeat misses are tolerated, then one bounded recovery session runs
    // (default backoff ~10s) before the honest failure screen appears.
    test.setTimeout(120000);
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    const connectBtn = s.getByRole('button', { name: 'Connect Terminal' });
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click();
    await expect(s.getByText('Terminal Connected')).toBeVisible({ timeout: 15000 });

    // Simulate the connector dying: block all requests to it.
    await page.route('http://127.0.0.1:11435/**', (route: any) => route.abort());
    // The verified install enters automatic recovery first…
    await expect(s.getByText('Recovering connection…')).toBeVisible({ timeout: 45000 });
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
    // …then falls back to the truthful failure screen when recovery exhausts.
    await expect(s.getByText('Terminal connection lost')).toBeVisible({ timeout: 45000 });
    await expect(s.getByRole('status')).toHaveAttribute('aria-label', 'Local connector not running');

    // Restore connectivity and retry with one click.
    await page.unroute('http://127.0.0.1:11435/**');
    await s.getByRole('button', { name: 'Retry' }).click();
    await expect(s.getByText('Terminal Connected')).toBeVisible({ timeout: 15000 });
  });

  test('automatic recovery can be cancelled and leaves an honest retry screen', async ({ page }) => {
    test.setTimeout(60000);
    // Arm a previously-verified install with the local restart launcher.
    await page.addInitScript(() => {
      localStorage.setItem('nexuss.terminal.setupVerified', '1');
      sessionStorage.setItem('nexuss.connector.protocolSeen', '1');
    });
    await page.route('http://127.0.0.1:11435/**', (route: any) => route.abort());
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    await s.getByRole('button', { name: 'Connect Terminal' }).click();
    await expect(s.getByText('Recovering connection…')).toBeVisible({ timeout: 15000 });
    await s.getByRole('button', { name: 'Cancel' }).click();
    await expect(s.getByText('Terminal connection lost')).toBeVisible({ timeout: 10000 });
    await expect(s.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
  });

  test('connector unavailable on first connect: truthful failure, no fake connected, setup offered', async ({ page }) => {
    await page.route('http://127.0.0.1:11435/**', (route: any) => route.abort());
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    // Passive check fails → the real Connect Terminal button is shown.
    await expect(s.getByRole('button', { name: 'Connect Terminal' })).toBeVisible({ timeout: 10000 });
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);

    await s.getByRole('button', { name: 'Connect Terminal' }).click();
    // First-time on this browser profile: guided one-time setup is offered.
    await expect(s.getByRole('button', { name: 'Set up terminal access' })).toBeVisible({ timeout: 10000 });
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
    // No technical details leak into the UI.
    const text = await s.innerText();
    expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|Failed to fetch|localhost|:\d{4,5}/);

    // The setup button must actually produce the downloadable installer.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      s.getByRole('button', { name: 'Set up terminal access' }).click()
    ]);
    expect(download.suggestedFilename()).toBe('Nexuss-Terminal-Setup.cmd');
  });

  test('browser local-network permission denied shows permission screen with Try Again', async ({ page }) => {
    await page.addInitScript(() => {
      const perms = (navigator as any).permissions;
      if (perms?.query) {
        const orig = perms.query.bind(perms);
        perms.query = (params: any) => {
          if (params?.name === 'local-network-access') return Promise.resolve({ state: 'denied' });
          return orig(params);
        };
      }
    });
    await gotoApp(page);
    await openTerminalPanel(page);
    const s = section(page);
    await expect(s.getByRole('button', { name: 'Connect Terminal' })).toBeVisible({ timeout: 10000 });
    await s.getByRole('button', { name: 'Connect Terminal' }).click();
    await expect(s.getByText('Local network permission required')).toBeVisible({ timeout: 10000 });
    await expect(s.getByRole('button', { name: 'Try Again' })).toBeVisible();
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);
  });

  test('normal AI chat works independently while the terminal is disconnected', async ({ page }) => {
    await gotoApp(page);
    // Ensure terminal is not connected for this session.
    await page.evaluate(() => { window.sessionStorage.setItem('nexuss.terminal.disconnected', '1'); });
    await mockChat(page, 'Paris is the capital of France.');
    await openTerminalPanel(page);
    const s = section(page);
    await expect(s.getByText('Terminal Connected')).toHaveCount(0);

    await send(page, 'What is the capital of France?');
    await expect(page.locator('text=Paris is the capital of France.').last()).toBeVisible({ timeout: 15000 });
    // Normal chat must not be blocked by the terminal gate.
    await expect(page.getByLabel('Message input')).toBeVisible();
  });
});
