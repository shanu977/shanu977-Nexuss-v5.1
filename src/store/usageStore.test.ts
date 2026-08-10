import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUsageStore } from "@/store/usageStore";
import db from "@/lib/db/db";

const mocks = vi.hoisted(() => {
  const current = { uid: null as string | null };
  return {
    authStoreMock: {
      useAuthStore: {
        getState: () => ({ user: current.uid ? { uid: current.uid } : null }),
        setState: () => {}
      }
    },
    setMockUser: (uid: string | null) => {
      current.uid = uid;
    }
  };
});

vi.mock("@/store/useAuthStore", () => mocks.authStoreMock);

const UID = "user-a";
const setMockUser = mocks.setMockUser;

beforeEach(async () => {
  await db.usageRecords.clear();
  setMockUser(UID);
  useUsageStore.setState({
    summary: { providers: [], totalRequests: 0, totalTokens: 0 },
    loading: false
  });
});

describe("usageStore", () => {
  it("records usage and builds summary", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      responseTime: 1200,
      success: true
    });

    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(2);
    expect(summary.totalTokens).toBe(450);
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0].provider).toBe("groq");
    expect(summary.providers[0].requests).toBe(2);
    expect(summary.providers[0].inputTokens).toBe(300);
    expect(summary.providers[0].outputTokens).toBe(150);
    expect(summary.providers[0].totalTokens).toBe(450);
    expect(summary.providers[0].avgResponseTime).toBe(1000);
    expect(summary.providers[0].models["llama-3.3-70b-versatile"].requests).toBe(2);
  });

  it("keeps providers separate", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      responseTime: 600,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "openrouter",
      model: "deepseek/deepseek-chat-v3",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      responseTime: 400,
      success: true
    });

    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(3);
    expect(summary.providers).toHaveLength(3);

    const groq = summary.providers.find((p) => p.provider === "groq");
    const gemini = summary.providers.find((p) => p.provider === "gemini");
    const openrouter = summary.providers.find((p) => p.provider === "openrouter");

    expect(groq?.requests).toBe(1);
    expect(groq?.totalTokens).toBe(150);
    expect(gemini?.requests).toBe(1);
    expect(gemini?.totalTokens).toBe(300);
    expect(openrouter?.requests).toBe(1);
    expect(openrouter?.totalTokens).toBe(75);
  });

  it("tracks failed requests separately", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      responseTime: 0,
      success: false
    });

    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(2);
    expect(summary.totalTokens).toBe(150);
  });

  it("clears usage data", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().clearUsage();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.providers).toHaveLength(0);

    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(0);
  });

  it("data survives page refresh via IndexedDB", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 500,
      outputTokens: 250,
      totalTokens: 750,
      responseTime: 500,
      success: true
    });

    // Simulate fresh load
    useUsageStore.setState({
      summary: { providers: [], totalRequests: 0, totalTokens: 0 }
    });

    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalTokens).toBe(750);
    expect(summary.providers[0].provider).toBe("gemini");
  });

  it("filters records by provider", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      responseTime: 600,
      success: true
    });

    const groqRecords = await useUsageStore.getState().getRecords("groq");
    expect(groqRecords).toHaveLength(1);
    expect(groqRecords[0].provider).toBe("groq");

    const allRecords = await useUsageStore.getState().getRecords();
    expect(allRecords).toHaveLength(2);
  });

  it("usage records are isolated between users", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    setMockUser("user-b");
    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    expect(summary.totalRequests).toBe(0);
    expect(summary.providers).toHaveLength(0);

    const bRecords = await useUsageStore.getState().getRecords();
    expect(bRecords).toHaveLength(0);

    // Back to A: records still present and owned by A.
    setMockUser(UID);
    await useUsageStore.getState().loadSummary();
    expect(useUsageStore.getState().summary.totalRequests).toBe(1);

    const aRecords = await useUsageStore.getState().getRecords();
    expect(aRecords).toHaveLength(1);
    expect(aRecords[0].userId).toBe(UID);
  });

  it("unauthenticated users cannot read or write usage records", async () => {
    setMockUser(null);

    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });
    await useUsageStore.getState().loadSummary();
    expect(useUsageStore.getState().summary.totalRequests).toBe(0);

    const records = await useUsageStore.getState().getRecords();
    expect(records).toHaveLength(0);
  });

  it("estimates context tokens from messages", () => {
    const estimateContextTokens = useUsageStore.getState().estimateContextTokens;
    const tokens = estimateContextTokens([
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there!" }
    ]);
    // "Hello world" = 11 chars, "Hi there!" = 9 chars, total = 20 chars
    // 20 / 4 = 5 tokens
    expect(tokens).toBe(5);
  });

  it("separates multiple models within same provider", async () => {
    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      responseTime: 800,
      success: true
    });

    await useUsageStore.getState().recordUsage({
      provider: "groq",
      model: "llama-3.1-8b-instant",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      responseTime: 300,
      success: true
    });

    await useUsageStore.getState().loadSummary();

    const { summary } = useUsageStore.getState();
    const groq = summary.providers.find((p) => p.provider === "groq");
    expect(groq?.requests).toBe(2);
    expect(groq?.totalTokens).toBe(225);
    expect(Object.keys(groq?.models || {})).toHaveLength(2);
    expect(groq?.models["llama-3.3-70b-versatile"].requests).toBe(1);
    expect(groq?.models["llama-3.1-8b-instant"].requests).toBe(1);
  });
});
