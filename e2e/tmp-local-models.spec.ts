import { test, expect, Page } from '@playwright/test';

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

const OLLAMA_ENDPOINT = 'http://localhost:11434/v1';

async function bootApp(page: Page) {
  const consoleErrors: string[] = [];
  const localNetworkErrors: string[] = [];
  const localRequests: string[] = [];
  const chatBodies: string[] = [];

  page.on('request', (req) => {
    if (/\/chat\/completions$/.test(req.url()) && req.method() === 'POST') {
      chatBodies.push(req.postData() ?? '');
    }
    if (/11434|11435/.test(req.url())) localRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));
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

  await page.addInitScript(() => {
    (window as unknown as { __NEXUSS_E2E_BYPASS?: boolean }).__NEXUSS_E2E_BYPASS = true;
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 60000 });

  return { consoleErrors, localNetworkErrors, localRequests, chatBodies };
}

async function openModels(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(page.getByLabel('Provider', { exact: true })).toBeVisible({ timeout: 60000 });
}

/** Walk the one-click flow: pick the provider (if asked) and press Connect. */
async function connectOllama(page: Page) {
  const connect = page.getByRole('button', { name: 'Connect Ollama' });
  if (!(await connect.isVisible().catch(() => false))) {
    // First run: the guided setup panel owns the screen — use the advanced
    // path to reach the manual provider chooser.
    await expect(page.getByTestId('local-setup-panel')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Advanced configuration' }).first().click();
    await expect(page.getByText('Connect a local AI')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /^Ollama/ }).click();
  }
  await connect.click();
  await expect(page.getByTestId('local-status-connected')).toBeVisible({ timeout: 60000 });
}

test('web local AI: choose provider, connect, discover, select model, chat', async ({ page }) => {
  test.setTimeout(300000);
  const { consoleErrors, localNetworkErrors, localRequests, chatBodies } = await bootApp(page);

  // --- Settings -> Models ---
  await openModels(page);

  // --- 1. first run opens the guided local setup, not a developer form ---
  await expect(page.getByTestId('local-setup-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Test Connection' })).toHaveCount(0);
  await expect(page.getByLabel('API Key')).toHaveCount(0);
  await expect(page.getByText(/Quick setup/)).toHaveCount(0);

  // --- 2. one click connects and auto-discovers ---
  await connectOllama(page);
  await expect(page.getByTestId('local-status-connected')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Ollama' })).toHaveCount(0);

  // --- 3. every installed model is listed on the provider card ---
  const localModelSelect = page.locator('select[id^="local-model-"]');
  await expect(localModelSelect).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await localModelSelect.locator('option').count()), {
      timeout: 30000,
      message: 'expected discovered Ollama models on the provider card',
    })
    .toBeGreaterThanOrEqual(EXPECTED_MODELS.length);
  const modelOptions = await localModelSelect.locator('option').allTextContents();
  for (const name of EXPECTED_MODELS) {
    expect(modelOptions, `missing model ${name}`).toContain(name);
  }
  // Exactly one "Model" control is ever labelled.
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(1);
  // The provider dropdown reports the connection.
  const providerSelect = page.getByLabel('Provider', { exact: true });
  await expect(providerSelect.locator('option', { hasText: 'Ollama • Connected' })).toHaveCount(1);
  await expect(providerSelect).toHaveValue(/^local:/);
  // The removed per-model list is gone.
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);

  // --- 4. select a local model on the card ---
  await localModelSelect.selectOption('qwen2.5-coder:7b');
  await expect(localModelSelect).toHaveValue('qwen2.5-coder:7b');

  // --- 5. back to chat ---
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 15000 });
  const selector = page.getByTitle('Select model');
  await expect(selector).toContainText('Local');
  await expect(selector).toContainText('qwen2.5-coder:7b');

  // --- 6. real chat through Ollama ---
  const assistantBefore = await page.locator('div.animate-message-in.justify-start').count();
  await page.getByLabel('Message input').fill('Reply with exactly: LOCAL-OK');
  await page.getByRole('button', { name: 'Send message' }).click();

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
  expect(await page.locator('div.animate-message-in.justify-start').count()).toBeGreaterThan(
    assistantBefore
  );
  expect(
    chatBodies.some((b) => b.includes('"qwen2.5-coder:7b"')),
    'chat request must use the selected local model'
  ).toBe(true);

  // --- 7. no CORS / localhost failures ---
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
    'expected a chat completion request to Ollama'
  ).toBe(true);
});

test('local providers: friendly failure, retry, disconnect and reconnect', async ({ page }) => {
  test.setTimeout(180000);
  await bootApp(page);
  await openModels(page);

  // Fresh profile: the guided setup auto-opens; the advanced path leads to the
  // disconnected card state after picking the provider.
  await expect(page.getByTestId('local-setup-panel')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Advanced configuration' }).first().click();
  await expect(page.getByText('Connect a local AI')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: /^Ollama/ }).click();
  await expect(page.getByTestId('local-status-disconnected')).toBeVisible();
  await expect(page.getByText('Run AI models locally with Ollama')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Ollama' })).toBeVisible();

  // --- dead endpoint -> friendly failure, no developer text ---
  await page.getByRole('button', { name: 'Advanced connection settings' }).click();
  await page.getByLabel('Endpoint').fill('http://localhost:59999/v1');
  await page.getByRole('button', { name: 'Connect Ollama' }).click();
  await expect(page.getByTestId('local-status-failed')).toBeVisible({ timeout: 60000 });

  const card = page.getByTestId('local-provider-card-ollama');
  const cardText = await card.innerText();
  expect(cardText).toMatch(/Couldn't connect to Ollama/i);
  expect(cardText).not.toMatch(
    /ECONNREFUSED|TypeError|fetch failed|OLLAMA_ORIGINS|stack|at Object\.|localhost:11434/
  );
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(card.getByRole('alert')).toBeVisible();

  // --- fix the endpoint and retry -> connected ---
  await page.getByLabel('Endpoint').fill(OLLAMA_ENDPOINT);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('local-status-connected')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('select[id^="local-model-"]')).toBeVisible({ timeout: 30000 });

  // --- disconnect -> model picker is gone, provider is not offered as local ---
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('local-status-disconnected')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Connect Ollama' })).toBeVisible();
  await expect(page.locator('select[id^="local-model-"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);

  // --- one click reconnects ---
  await page.getByRole('button', { name: 'Connect Ollama' }).click();
  await expect(page.getByTestId('local-status-connected')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('select[id^="local-model-"]')).toBeVisible({ timeout: 30000 });
});

test('local providers: connection and model selection survive a reload', async ({ page }) => {
  test.setTimeout(180000);
  await bootApp(page);
  await openModels(page);
  await connectOllama(page);

  const localModelSelect = page.locator('select[id^="local-model-"]');
  await expect(localModelSelect).toBeVisible({ timeout: 30000 });
  await localModelSelect.selectOption('qwen2.5-coder:7b');
  await expect(localModelSelect).toHaveValue('qwen2.5-coder:7b');
  await expect(page.getByLabel('Provider', { exact: true })).toHaveValue(/^local:/);

  // --- reload: the persisted connection is restored ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 60000 });
  await openModels(page);

  await expect(page.getByText('Connect a local AI')).toHaveCount(0);
  await expect(page.getByTestId('local-status-connected')).toBeVisible({ timeout: 60000 });
  const providerSelect = page.getByLabel('Provider', { exact: true });
  await expect(providerSelect.locator('option', { hasText: 'Ollama • Connected' })).toHaveCount(1);
  await expect(providerSelect).toHaveValue(/^local:/);
  await expect(page.locator('select[id^="local-model-"]')).toHaveValue(
    'qwen2.5-coder:7b',
    { timeout: 30000 }
  );
});
