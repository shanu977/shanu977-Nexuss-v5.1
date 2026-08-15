"use client";

import { Chat } from "@/types";
import { PinIcon } from "@/components/icons";

interface PinnedListProps {
  chats: Chat[];
  currentChatId: string | null;
  onSelect: (id: string) => void;
}

export default function PinnedList({
  chats,
  currentChatId,
  onSelect
}: PinnedListProps) {
  if (chats.length === 0) return null;

  return (
    <section className="shrink-0 px-2 pt-3">
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <PinIcon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Pinned
        </span>
      </div>
      <div className="space-y-0.5">
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            onClick={() => onSelect(chat.id)}
            className={`w-full rounded-xl px-3 py-2 text-left text-xs transition-colors ${
              currentChatId === chat.id
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span className="truncate">{chat.title || "Untitled conversation"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
