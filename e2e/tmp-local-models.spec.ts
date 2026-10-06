import { test, expect } from '@playwright/test';

const EXPECTED_MODELS = [
  'qwen2.5-coder:7b',
  'qwen3:4b-strix',
  'qwen3:4b',
  'hermes3:latest',
  'qwen2.5:3b',
  'phi3:latest',
  'llama3.1:8b',
  'nomic-embed-text:latest',
  'qwen2.5-coder:1.5b-base',
  'qwen3:8b',
];

test('web local AI: discover Ollama, select model, chat, no CORS errors', async ({ page }) => {
  test.setTimeout(300000);

  const consoleErrors: string[] = [];
  const localNetworkErrors: string[] = [];
  const localRequests: string[] = [];
  const chatBodies: string[] = [];

  page.on('request', (req) => {
    if (/\/chat\/completions$/.test(req.url()) && req.method() === 'POST') {
      chatBodies.push(req.postData() ?? '');
    }
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on('request', (req) => {
    if (/11434|11435/.test(req.url())) localRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on('requestfailed', (req) => {
    if (/11434|11435/.test(req.url())) {
      localNetworkErrors.push(`FAILED ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
    }
  });
  page.on('response', (res) => {
    if (/11434|11435/.test(res.url()) && res.status() >= 400) {
      localNetworkErrors.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });

  // --- 1. open the web app ---
  await page.addInitScript(() => {
    (window as unknown as { __NEXUSS_E2E_BYPASS?: boolean }).__NEXUSS_E2E_BYPASS = true;
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 60000 });

  // --- 2. Settings -> Models ---
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Models' }).click();

  // --- 3+4. discovery / Ollama detected as a provider ---
  const providerSelect = page.getByLabel('Provider', { exact: true });
  await expect(providerSelect).toBeVisible({ timeout: 60000 });
  await expect(providerSelect.locator('option', { hasText: 'Ollama • Connected' })).toHaveCount(1, {
    timeout: 60000,
  });

  // --- 5. all 10 installed models discovered and listed in the Model dropdown ---
  const modelSelect = page.getByLabel('Model', { exact: true });
  await expect(modelSelect).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await modelSelect.locator('option').count()), {
      timeout: 30000,
      message: 'expected discovered Ollama models in the Model dropdown',
    })
    .toBeGreaterThanOrEqual(EXPECTED_MODELS.length);
  const modelOptions = await modelSelect.locator('option').allTextContents();
  for (const name of EXPECTED_MODELS) {
    expect(modelOptions, `missing model ${name}`).toContain(name);
  }
  // The old per-model [Select] list is gone: selection happens in the dropdown.
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);

  // --- 6. select a local model ---
  await modelSelect.selectOption('qwen2.5-coder:7b');
  await expect(modelSelect).toHaveValue('qwen2.5-coder:7b');

  // --- 7. return to chat ---
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 15000 });

  // --- 8. model selector shows the selected local model ---
  const selector = page.getByTitle('Select model');
  await expect(selector).toContainText('Local');
  await expect(selector).toContainText('qwen2.5-coder:7b');

  // --- 9. send a test message ---
  const assistantBefore = await page.locator('div.animate-message-in.justify-start').count();
  await page.getByLabel('Message input').fill('Reply with exactly: LOCAL-OK');
  await page.getByRole('button', { name: 'Send message' }).click();

  // --- 10. response returned (must be real model output, not the placeholder) ---
  const assistant = page.locator('div.animate-message-in.justify-start').last();
  await expect
    .poll(
      async () => {
        const text = (await assistant.innerText()).trim();
        if (!text) return false;
        if (text.includes('Nexuss is thinking...')) return false;
        return !/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(text.replace(/\n+/g, ' ').trim());
      },
      { timeout: 150000, messages: 'assistant reply never became real content' }
    )
    .toBe(true);

  const reply = (await assistant.innerText()).trim();
  expect(reply).not.toContain('Cannot connect to local model');
  expect(reply.length).toBeGreaterThan(0);
  expect(
    await page.locator('div.animate-message-in.justify-start').count()
  ).toBeGreaterThan(assistantBefore);

  expect(
    chatBodies.some((b) => b.includes('"qwen2.5-coder:7b"')),
    'chat request must use the selected local model'
  ).toBe(true);

  // --- 11. console / CORS / localhost errors ---
  const relevantConsoleErrors = consoleErrors.filter((e) =>
    /11434|11435|cors|access-control|failed to fetch|networkerror|chunk load|uncaught/i.test(e)
  );

  console.log('--- LOCAL REQUESTS (11434/11435) ---');
  console.log(localRequests.join('\n') || '(none)');
  console.log('--- LOCAL NETWORK ERRORS ---');
  console.log(localNetworkErrors.join('\n') || '(none)');
  console.log('--- CONSOLE ERRORS/WARNINGS ---');
  console.log(consoleErrors.join('\n') || '(none)');
  console.log('--- ASSISTANT REPLY ---');
  console.log(reply.slice(0, 500));

  expect(localNetworkErrors, 'localhost:11434/11435 request failures').toEqual([]);
  expect(relevantConsoleErrors, 'console errors mentioning CORS/localhost').toEqual([]);
  expect(
    localRequests.some((r) => r.includes('/chat/completions')),
    'expected a chat completion request to Ollama/connector'
  ).toBe(true);
});
