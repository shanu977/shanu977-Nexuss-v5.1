"use client";

import {
  PlusIcon,
  ChatIcon,
  ImageIcon,
  LibraryIcon,
  ClockIcon,
  PuzzleIcon,
  FolderIcon
} from "@/components/icons";

interface SidebarNavigationProps {
  onNewChat: () => void;
}

// Placeholder entries mirror the navigation structure of the reference UI.
// They are intentionally inert: none of these features exist yet in this
// project, so the buttons do not navigate anywhere.
const NAV_ITEMS = [
  { label: "New chat", icon: ChatIcon },
  { label: "Images", icon: ImageIcon },
  { label: "Library", icon: LibraryIcon },
  { label: "Scheduled", icon: ClockIcon },
  { label: "Plugins", icon: PuzzleIcon },
  { label: "Projects", icon: FolderIcon }
] as const;

export default function SidebarNavigation({ onNewChat }: SidebarNavigationProps) {
  return (
    <nav className="shrink-0 space-y-1 px-3 pt-3" aria-label="Main navigation">
      <button
        type="button"
        onClick={onNewChat}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3.5 py-2.5 text-xs font-semibold text-primary-foreground shadow-xs transition-all hover:opacity-90 active:scale-[0.99] cursor-pointer"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        <span>New chat</span>
      </button>

      <div className="space-y-0.5 pt-2">
        {NAV_ITEMS.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
