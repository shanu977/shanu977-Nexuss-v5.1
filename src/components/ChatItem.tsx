"use client";

import { useState, useEffect, useRef } from "react";
import { Chat } from "@/types";

interface ChatItemProps {
  chat: Chat;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export default function ChatItem({
  chat,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: ChatItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const dateLabel = new Date(chat.updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      className={`group relative flex cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2.5 transition-all duration-150 border ${
        isActive
          ? "bg-accent border-border font-medium text-foreground shadow-xs"
          : "border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground"
      }`}
      onClick={onSelect}
      role="button"
      aria-current={isActive ? "true" : undefined}
    >
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <p className="truncate text-xs font-semibold tracking-tight">
          {chat.title || "Untitled conversation"}
        </p>
        <p className="text-[10px] font-mono opacity-70">{dateLabel}</p>
      </div>

      {/* 3-Dots Action Menu */}
      <div className="relative shrink-0" ref={menuRef} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs transition-opacity cursor-pointer ${
            menuOpen
              ? "opacity-100 bg-muted text-foreground"
              : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          aria-label="Conversation actions"
          aria-expanded={menuOpen}
        >
          •••
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-8 z-40 w-36 rounded-xl border border-border bg-popover p-1 shadow-xl animate-in fade-in zoom-in-95 text-popover-foreground font-sans">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              
              <span>Rename</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
            >
             
              <span>Delete</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
