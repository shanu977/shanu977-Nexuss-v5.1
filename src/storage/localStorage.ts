const STORAGE_KEYS = {
  LAST_CHAT_ID: "lastChatId",
  THEME: "theme",
  PROVIDER: "provider",
  MODEL: "model"
};

function getItem<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch {
    return fallback;
  }
}

function setItem<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function getLastChatId(uid: string): string | null {
  return getItem<string | null>(`${STORAGE_KEYS.LAST_CHAT_ID}:${uid}`, null);
}

export function setLastChatId(uid: string, id: string | null): void {
  const key = `${STORAGE_KEYS.LAST_CHAT_ID}:${uid}`;
  if (id === null) {
    localStorage.removeItem(key);
  } else {
    setItem(key, id);
  }
}

export function getLocalTheme(): string {
  return getItem<string>(STORAGE_KEYS.THEME, "dark");
}

export function setLocalTheme(theme: string): void {
  setItem(STORAGE_KEYS.THEME, theme);
}

// ---- Provider/model (device-local, like theme) ----

export function getLocalProvider(): string {
  return getItem<string>(STORAGE_KEYS.PROVIDER, "groq");
}

export function setLocalProvider(provider: string): void {
  setItem(STORAGE_KEYS.PROVIDER, provider);
}

export function getLocalModel(): string | null {
  return getItem<string | null>(STORAGE_KEYS.MODEL, null);
}

export function setLocalModel(model: string): void {
  setItem(STORAGE_KEYS.MODEL, model);
}

export function clearAccountStorage(): void {
  if (typeof window === "undefined") return;
  try {
    // Clear every account-scoped lastChatId key (we may not know which uid
    // was active at sign-out time), plus the device-local prefs.
    const prefix = `${STORAGE_KEYS.LAST_CHAT_ID}:`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.removeItem(STORAGE_KEYS.THEME);
    window.localStorage.removeItem(STORAGE_KEYS.PROVIDER);
    window.localStorage.removeItem(STORAGE_KEYS.MODEL);
  } catch {
    // ignore
  }
}

export { STORAGE_KEYS };
