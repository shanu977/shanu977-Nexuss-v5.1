import Dexie, { type EntityTable } from "dexie";
import { Chat, Message } from "@/types/chats";
import { UsageRecord } from "@/types/usage";
import { LocalProvider, LocalModel } from "@/types/localModels";

const db = new Dexie("chatbot-db") as Dexie & {
  chats: EntityTable<Chat, "id">;
  messages: EntityTable<Message, "id">;
  usageRecords: EntityTable<UsageRecord, "id">;
  localProviders: EntityTable<LocalProvider, "id">;
  localModels: EntityTable<LocalModel, "id">;
};

db.version(1).stores({
  chats: "id, title, provider, createdAt, updatedAt",
  messages: "id, chatId, role, timestamp"
});

db.version(2).stores({
  usageRecords: "id, provider, model, timestamp, success"
});

// Add Firebase UID ownership to chats and usage records. Existing rows lack
// `userId`, so they remain in the database but are never matched by any
// user-scoped query (undefined !== uid) and are therefore not exposed.
db.version(3).stores({
  chats: "id, userId, [userId+updatedAt], title, provider, createdAt, updatedAt",
  messages: "id, chatId, role, timestamp",
  usageRecords: "id, userId, [userId+timestamp], provider, model, timestamp, success"
});

// Optimize per-chat message retrieval: compound index for sorted fetch.
// Keeps existing indexes for backward compatibility.
db.version(4).stores({
  chats: "id, userId, [userId+updatedAt], title, provider, createdAt, updatedAt",
  messages: "id, chatId, role, timestamp, [chatId+timestamp]",
  usageRecords: "id, userId, [userId+timestamp], provider, model, timestamp, success"
});

// Local models: per-user, client-side only (never sent to backend).
db.version(5).stores({
  chats: "id, userId, [userId+updatedAt], title, provider, createdAt, updatedAt",
  messages: "id, chatId, role, timestamp, [chatId+timestamp]",
  usageRecords: "id, userId, [userId+timestamp], provider, model, timestamp, success",
  localProviders: "id, userId, providerType, endpoint, enabled, createdAt",
  localModels: "id, userId, providerId, modelId, enabled, createdAt, [providerId+modelId], [userId+enabled]"
});

export default db;
