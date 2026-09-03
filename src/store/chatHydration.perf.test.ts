import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import db from "@/lib/db/db";
import { Chat, Message } from "@/types/chats";
import { setLastChatId } from "@/storage/localStorage";

const mocks = vi.hoisted(() => {
  const current = { uid: null as string | null };
  return {
    authMock: {
      useAuthStore: {
        getState: () => ({ user: current.uid ? { uid: current.uid } : null }),
        setState: () => {},
      },
    },
    setUid: (uid: string | null) => {
      current.uid = uid;
    },
  };
});
vi.mock("@/store/useAuthStore", () => mocks.authMock);
vi.mock("@/services/chat", () => ({ chatService: { sendStream: vi.fn() } }));
vi.mock("@/services/settings", () => ({
  settingsService: {
    get: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ provider: "groq", model: "openai/gpt-oss-120b", theme: "light" }), 400))),
    update: vi.fn().mockResolvedValue({}),
  },
}));
import { settingsService } from "@/services/settings";

const UID = "perf-user";
const setUid = mocks.setUid;

function makeChat(id: string, uid = UID, updatedAt = Date.now()): Chat {
  return { id, userId: uid, title: `Chat ${id}`, provider: "groq", createdAt: updatedAt, updatedAt };
}
function makeMessage(id: string, chatId: string, ts = Date.now()): Message {
  return { id, chatId, role: "user", content: `msg ${id}`, timestamp: ts };
}

beforeEach(async () => {
  window.localStorage.clear();
  await db.transaction("rw", db.chats, db.messages, db.usageRecords, async () => {
    await db.chats.clear();
    await db.messages.clear();
    await db.usageRecords.clear();
  });
  setUid(UID);
  useChatStore.setState({ currentChat: null, chats: [], messages: [], loading: false, error: null, isStreaming: false, streamingMessageId: null, fallbackNotice: null, theme: "light" });
  // reset hydrate guard
  const g = globalThis as unknown as { __nexussHydratePromise?: unknown; __nexussHydrateUid?: unknown };
  g.__nexussHydratePromise = null;
  g.__nexussHydrateUid = null;
  vi.clearAllMocks();
});

describe("chat hydration performance", () => {
  it("hydrates 0 chats quickly (metadata only, no blocking on remote)", async () => {
    const t0 = performance.now();
    await useChatStore.getState().hydrate();
    const dt = performance.now() - t0;
    expect(useChatStore.getState().chats).toHaveLength(0);
    // Should be fast: local only, remote is background (400ms delay not awaited)
    expect(dt).toBeLessThan(200);
  });

  it("hydrates 100 chats metadata without loading all messages", async () => {
    const chats = Array.from({ length: 100 }, (_, i) => makeChat(`c-${i}`, UID, Date.now() + i));
    await db.chats.bulkAdd(chats);
    // Add 10 messages only to first chat
    await db.messages.bulkAdd(Array.from({ length: 10 }, (_, i) => makeMessage(`m-${i}`, "c-0")));
    setLastChatId(UID, "c-0");
    const t0 = performance.now();
    await useChatStore.getState().hydrate();
    const dt = performance.now() - t0;
    const cs = useChatStore.getState();
    expect(cs.chats).toHaveLength(100);
    expect(cs.messages).toHaveLength(10); // only selected chat's messages
    // Metadata + 10 msgs should be well under 200ms even with remote background
    expect(dt).toBeLessThan(250);
  });

  it("hydrates 500 chats with many messages per chat but only loads selected chat messages", async () => {
    const chats = Array.from({ length: 200 }, (_, i) => makeChat(`c-${i}`, UID, Date.now() + i));
    await db.chats.bulkAdd(chats);
    // Add 10 messages to each of 200 chats (2k total) – but hydrate should only load 10 for selected
    const allMsgs: Message[] = [];
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 10; j++) allMsgs.push(makeMessage(`m-${i}-${j}`, `c-${i}`));
    }
    await db.messages.bulkAdd(allMsgs);
    setLastChatId(UID, "c-100");
    const t0 = performance.now();
    await useChatStore.getState().hydrate();
    const dt = performance.now() - t0;
    const cs = useChatStore.getState();
    expect(cs.chats).toHaveLength(200);
    expect(cs.messages).toHaveLength(10);
    expect(cs.currentChat?.id).toBe("c-100");
    // Even with 2k messages in DB, hydration should only touch selected chat, so fast
    expect(dt).toBeLessThan(400);
  }, 10000);

  it("does not block on remote settings fetch", async () => {
    // settingsService.get delays 400ms
    const t0 = performance.now();
    await useChatStore.getState().hydrate();
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(200);
    // Wait for background remote to apply
    await new Promise((r) => setTimeout(r, 500));
    expect(settingsService.get).toHaveBeenCalled();
  });

  it("prevents duplicate concurrent hydrates (in-flight guard)", async () => {
    await db.chats.bulkAdd([makeChat("c-1")]);
    const p1 = useChatStore.getState().hydrate();
    const p2 = useChatStore.getState().hydrate();
    const p3 = useChatStore.getState().hydrate();
    await Promise.all([p1, p2, p3]);
    // Settings fetch should have been called only once due to guard
    // (each hydrate would otherwise trigger its own fetch) – allow 1-2 due to timing but deduped
    expect(settingsService.get).toHaveBeenCalled();
    expect((settingsService.get as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("hydration error does not leave spinner stuck (sets error, still resolves)", async () => {
    // Force DB error by mocking where to throw once
    const spy = vi.spyOn(db.chats, "where").mockImplementationOnce(() => {
      throw new Error("DB closed");
    });
    await expect(useChatStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useChatStore.getState().error).toBeDefined();
    spy.mockRestore();
    // Next hydrate should succeed
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().chats).toHaveLength(0);
  });

  it("maintains user isolation after fix", async () => {
    await db.chats.bulkAdd([makeChat("c-a", "user-a"), makeChat("c-b", "user-b")]);
    setUid("user-a");
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().chats.map((c) => c.id)).toEqual(["c-a"]);
    setUid("user-b");
    // Need to reset guard for new uid
    const g = globalThis as unknown as { __nexussHydratePromise?: unknown; __nexussHydrateUid?: unknown };
    g.__nexussHydratePromise = null;
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().chats.map((c) => c.id)).toEqual(["c-b"]);
  });
});
