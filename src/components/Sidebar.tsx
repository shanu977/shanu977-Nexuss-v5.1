"use client";

import { useState, useEffect } from "react";
import { useChatStore } from "@/store";
import { useAuthStore } from "@/store/useAuthStore";
import RenameModal from "@/components/RenameModal";
import DeleteModal from "@/components/DeleteModal";
import Settings from "@/components/Settings";
import SidebarNavigation from "@/components/SidebarNavigation";
import PinnedList from "@/components/PinnedList";
import RecentChats from "@/components/RecentChats";
import UserMenu from "@/components/UserMenu";
import { SearchIcon, PanelLeftIcon } from "@/components/icons";
import { Chat } from "@/types";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [search, setSearch] = useState("");
  const chats = useChatStore((s) => s.chats);
  const currentChat = useChatStore((s) => s.currentChat);
  const createNewChat = useChatStore((s) => s.createNewChat);
  const loadChat = useChatStore((s) => s.loadChat);
  const searchChats = useChatStore((s) => s.searchChats);
  const [searchResults, setSearchResults] = useState<Chat[] | null>(null);

  const [renameTarget, setRenameTarget] = useState<Chat | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chat | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  // Debounced conversation search.
  useEffect(() => {
    let cancelled = false;
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const results = await searchChats(search);
      if (!cancelled) setSearchResults(results);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, searchChats]);

  // Close the mobile drawer with the Escape key.
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  const displayChats =
    searchResults !== null
      ? searchResults.filter((r) => chats.some((c) => c.id === r.id))
      : chats;
  const searching = searchResults !== null;

  const handleNewChat = async () => {
    await createNewChat();
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      onClose();
    }
  };

  const handleSelectChat = (id: string) => {
    loadChat(id);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      onClose();
    }
  };

  const userEmail = user?.email || "User";
  const avatarChar = userEmail[0]?.toUpperCase() || "U";

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar Container with Smooth Slide Animation */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col border-border bg-card text-card-foreground transition-all duration-300 ease-in-out lg:static lg:z-auto shrink-0 shadow-lg lg:shadow-none overflow-hidden ${
          isOpen
            ? "w-72 max-w-[85vw] border-r opacity-100 translate-x-0"
            : "w-0 max-w-0 border-r-0 opacity-0 -translate-x-full pointer-events-none"
        }`}
      >
        {/* Header - Branding + Collapse */}
        <div className="flex items-center justify-between px-3.5 py-3 shrink-0">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="relative h-6 w-6 flex items-center justify-center shrink-0">
              <img
                src="/nexuss-logo.png"
                alt="NEXUSS Logo"
                className="h-full w-full object-contain"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs font-bold uppercase tracking-widest text-foreground font-mono">
                NEXUSS
              </span>
              <span className="rounded bg-muted border border-border px-1.5 py-0.5 text-[9px] font-mono font-semibold text-muted-foreground whitespace-nowrap">
                AI
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close sidebar"
            aria-label="Close sidebar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <PanelLeftIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 pb-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search conversations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
              aria-label="Search chats"
            />
          </div>
        </div>

        <SidebarNavigation onNewChat={() => void handleNewChat()} />

        <div className="mx-3 mt-3 h-px shrink-0 bg-border" />

        {/* Pinned (empty until a pinning feature exists) */}
        <PinnedList
          chats={[]}
          currentChatId={currentChat?.id ?? null}
          onSelect={handleSelectChat}
        />

        {/* Recent conversations (scrolls independently) */}
        <RecentChats
          chats={displayChats}
          currentChatId={currentChat?.id ?? null}
          searching={searching}
          onSelect={handleSelectChat}
          onRename={setRenameTarget}
          onDelete={setDeleteTarget}
          onNewChat={() => void handleNewChat()}
        />

        {/* Footer: Settings + User Menu */}
        <div className="border-t border-border p-2.5 shrink-0">
          <UserMenu
            email={userEmail}
            avatarChar={avatarChar}
            onOpenSettings={() => setSettingsOpen(true)}
            onSignOut={() => void signOut()}
          />
        </div>
      </aside>

      {/* Rename Modal */}
      {renameTarget && (
        <RenameModal
          isOpen={!!renameTarget}
          onClose={() => setRenameTarget(null)}
          chatId={renameTarget.id}
          currentTitle={renameTarget.title}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <DeleteModal
          isOpen={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          chatId={deleteTarget.id}
          chatTitle={deleteTarget.title}
        />
      )}

      {/* Settings Modal */}
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
