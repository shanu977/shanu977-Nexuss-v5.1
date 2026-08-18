"use client";

import { PlusIcon } from "@/components/icons";

interface SidebarNavigationProps {
  onNewChat: () => void;
}

export default function SidebarNavigation({ onNewChat }: SidebarNavigationProps) {
  return (
    <nav className="shrink-0 px-3 pt-3" aria-label="Main navigation">
      <button
        type="button"
        onClick={onNewChat}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3.5 py-2.5 text-xs font-semibold text-primary-foreground shadow-xs transition-all hover:opacity-90 active:scale-[0.99] cursor-pointer"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        <span>New chat</span>
      </button>
    </nav>
  );
}
