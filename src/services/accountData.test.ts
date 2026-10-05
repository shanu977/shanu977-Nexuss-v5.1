import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db from "@/lib/db/db";
import { gatherLocalAccountExport, purgeLocalAccountData } from "@/services/accountData";

const UID_A = "user-a";
const UID_B = "user-b";

function makeChat(id: string, userId: string) {
  return { id, userId, title: id, provider: "groq" as const, createdAt: 1, updatedAt: 1 };
}

function makeMessage(id: string, chatId: string, content: string) {
  return { id, chatId, role: "user" as const, content, timestamp: 1 };
}

function makeUsage(id: string, userId: string) {
  return {
    id,
    userId,
    provider: "groq" as const,
    model: "llama-3.3-70b",
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    responseTime: 10,
    timestamp: 1,
    success: true
  };
}

function makeProvider(id: string, userId: string) {
  return {
    id,
    userId,
    name: `provider-${id}`,
    providerType: "ollama" as const,
    endpoint: "http://localhost:11434/v1",
    apiKey: `secret-${id}`,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  };
}

function makeLocalModel(id: string, userId: string, providerId: string) {
  return {
    id,
    userId,
    providerId,
    modelId: id,
    displayName: id,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  };
}

async function seed() {
  await db.chats.bulkPut([makeChat("chat-a-1", UID_A), makeChat("chat-b-1", UID_B)]);
  await db.messages.bulkPut([
    makeMessage("msg-a-1", "chat-a-1", "hello from a"),
    makeMessage("msg-b-1", "chat-b-1", "hello from b")
  ]);
  await db.usageRecords.bulkPut([makeUsage("use-a-1", UID_A), makeUsage("use-b-1", UID_B)]);
  await db.localProviders.bulkPut([makeProvider("prov-a-1", UID_A), makeProvider("prov-b-1", UID_B)]);
  await db.localModels.bulkPut([
    makeLocalModel("model-a-1", UID_A, "prov-a-1"),
    makeLocalModel("model-b-1", UID_B, "prov-b-1")
  ]);

  localStorage.setItem("lastChatId:user-a", "chat-a-1");
  localStorage.setItem("lastChatId:user-b", "chat-b-1");
  localStorage.setItem("nexuss_agent_state_chat-a-1", "a-state");
  localStorage.setItem("nexuss_agent_state_chat-b-1", "b-state");
  localStorage.setItem("nexuss_exec_context_chat-a-1", "a-ctx");
  localStorage.setItem("nexuss_exec_context_chat-b-1", "b-ctx");
  localStorage.setItem(
    "nexuss_exec_context",
    JSON.stringify([{ chatId: "chat-a-1" }, { chatId: "chat-b-1" }])
  );
}

beforeEach(async () => {
  await db.chats.clear();
  await db.messages.clear();
  await db.usageRecords.clear();
  await db.localProviders.clear();
  await db.localModels.clear();
  localStorage.clear();
  await seed();
});

afterEach(async () => {
  await db.chats.clear();
  await db.messages.clear();
  await db.usageRecords.clear();
  await db.localProviders.clear();
  await db.localModels.clear();
  localStorage.clear();
});

describe("purgeLocalAccountData", () => {
  it("removes only the deleted account's rows", async () => {
    await purgeLocalAccountData(UID_A);

    expect(await db.chats.toArray()).toEqual([makeChat("chat-b-1", UID_B)]);
    expect(await db.messages.toArray()).toEqual([
      makeMessage("msg-b-1", "chat-b-1", "hello from b")
    ]);
    expect(await db.usageRecords.toArray()).toEqual([makeUsage("use-b-1", UID_B)]);
    expect(await db.localProviders.toArray()).toEqual([makeProvider("prov-b-1", UID_B)]);
    expect(await db.localModels.toArray()).toEqual([
      makeLocalModel("model-b-1", UID_B, "prov-b-1")
    ]);
  });

  it("removes the account's local keys but keeps the other account's", async () => {
    await purgeLocalAccountData(UID_A);

    expect(localStorage.getItem("lastChatId:user-a")).toBeNull();
    expect(localStorage.getItem("lastChatId:user-b")).toBe("chat-b-1");
    expect(localStorage.getItem("nexuss_agent_state_chat-a-1")).toBeNull();
    expect(localStorage.getItem("nexuss_agent_state_chat-b-1")).toBe("b-state");
    expect(localStorage.getItem("nexuss_exec_context_chat-a-1")).toBeNull();
    expect(localStorage.getItem("nexuss_exec_context_chat-b-1")).toBe("b-ctx");
    expect(JSON.parse(localStorage.getItem("nexuss_exec_context") ?? "[]")).toEqual([
      { chatId: "chat-b-1" }
    ]);
  });

  it("is a no-op for an account with no local data", async () => {
    await purgeLocalAccountData("unknown-user");
    expect(await db.chats.count()).toBe(2);
    expect(localStorage.getItem("lastChatId:user-a")).toBe("chat-a-1");
  });
});

describe("gatherLocalAccountExport", () => {
  it("includes only the signed-in account's data", async () => {
    const exported = await gatherLocalAccountExport(UID_A);

    expect(exported.chats).toEqual([makeChat("chat-a-1", UID_A)]);
    expect(exported.messages).toEqual([makeMessage("msg-a-1", "chat-a-1", "hello from a")]);
    expect(exported.usageRecords).toEqual([makeUsage("use-a-1", UID_A)]);
    expect(exported.localModels).toEqual([makeLocalModel("model-a-1", UID_A, "prov-a-1")]);
    expect(exported.localPreferences.lastChatId).toBe("chat-a-1");
    expect(JSON.stringify(exported)).not.toContain("hello from b");
    expect(JSON.stringify(exported)).not.toContain("chat-b-1");
  });

  it("never includes local endpoint API keys", async () => {
    const exported = await gatherLocalAccountExport(UID_A);

    expect(exported.localProviders).toHaveLength(1);
    const provider = exported.localProviders[0] as Record<string, unknown>;
    expect(provider.apiKey).toBeUndefined();
    expect(Object.keys(provider).sort()).toEqual([
      "createdAt",
      "enabled",
      "endpoint",
      "id",
      "name",
      "providerType",
      "updatedAt",
      "userId"
    ]);
    expect(JSON.stringify(exported)).not.toContain("secret-prov-a-1");
    expect(exported.notes.join(" ")).toContain("never exported");
  });
});
