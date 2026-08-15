"use client";

import { Chat } from "@/types";
import ChatItem from "@/components/ChatItem";
import { ChatIcon } from "@/components/icons";

interface RecentChatsProps {
  chats: Chat[];
  currentChatId: string | null;
  searching: boolean;
  onSelect: (id: string) => void;
  onRename: (chat: Chat) => void;
  onDelete: (chat: Chat) => void;
  onNewChat: () => void;
}

export default function RecentChats({
  chats,
  currentChatId,
  searching,
  onSelect,
  onRename,
  onDelete,
  onNewChat
}: RecentChatsProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 pb-1.5 pt-3 shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Recents ({chats.length})
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-0.5 px-1">
        {chats.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <ChatIcon className="h-5 w-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              {searching ? "No matching conversations" : "No conversations yet"}
            </p>
            {!searching && (
              <button
                type="button"
                onClick={onNewChat}
                className="rounded-lg border border-border bg-muted/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
              >
                Start a new conversation
              </button>
            )}
          </div>
        ) : (
          chats.map((chat) => (
            <ChatItem
              key={chat.id}
              chat={chat}
              isActive={currentChatId === chat.id}
              onSelect={() => onSelect(chat.id)}
              onRename={() => onRename(chat)}
              onDelete={() => onDelete(chat)}
            />
          ))
        )}
      </div>
    </section>
  );
}
