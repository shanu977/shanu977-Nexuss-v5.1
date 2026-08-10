"use client";

import { useState, useEffect, useRef } from "react";
import { useChatStore } from "@/store";
import { useAuthStore } from "@/store/useAuthStore";
import ChatItem from "@/components/ChatItem";
import RenameModal from "@/components/RenameModal";
import DeleteModal from "@/components/DeleteModal";
import Settings from "@/components/Settings";
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

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

  useEffect(() => {
    if (!profileMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [profileMenuOpen]);

  const displayChats =
    searchResults !== null
      ? searchResults.filter((r) => chats.some((c) => c.id === r.id))
      : chats;
  const searching = searchResults !== null;

  const handleNewChat = async () => {
    await createNewChat();
    onClose();
  };

  const handleSelectChat = (id: string) => {
    loadChat(id);
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
        {/* Header - Branding Only */}
        <div className="flex items-center justify-between border-b border-border px-3.5 py-3.5 shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="relative w-6 h-6 flex items-center justify-center shrink-0">
              <img
                src="/nexuss-logo.png"
                alt="NEXUSS Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tracking-widest text-foreground font-mono uppercase whitespace-nowrap">
                NEXUSS
              </span>
              <span className="rounded bg-muted border border-border px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground font-semibold whitespace-nowrap">
                AI
              </span>
            </div>
          </div>
        </div>

        {/* Action Button & Search */}
        <div className="space-y-2.5 p-3 border-b border-border shrink-0 min-w-[288px]">
          <button
            onClick={() => void handleNewChat()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-3.5 py-2.5 text-xs font-semibold shadow-xs hover:opacity-90 transition-all active:scale-[0.99] cursor-pointer"
          >
            <span className="text-sm font-bold">+</span>
            <span>New conversation</span>
          </button>

          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono"
            >
              ⌕
            </span>
            <input
              type="search"
              placeholder="Search conversations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-input bg-background py-2 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground outline-none transition-colors focus:ring-1 focus:ring-ring"
              aria-label="Search chats"
            />
          </div>
        </div>

        {/* Chat History List */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1 min-w-[288px]">
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground font-mono">
              Recent ({displayChats.length})
            </span>
          </div>
          {displayChats.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-xs text-muted-foreground">
                {searching ? "No matching conversations" : "No conversations yet"}
              </p>
              {!searching && (
                <p className="mt-1 text-[11px] opacity-70 text-muted-foreground">
                  Start a new conversation to begin
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {displayChats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={currentChat?.id === chat.id}
                  onSelect={() => handleSelectChat(chat.id)}
                  onRename={() => setRenameTarget(chat)}
                  onDelete={() => setDeleteTarget(chat)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer Section: Settings & User Profile */}
        <div className="border-t border-border p-2.5 bg-muted/30 space-y-1 shrink-0 min-w-[288px]">
          {/* Settings Trigger Item */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <span className="text-sm">⚙</span>
            <span>Settings</span>
          </button>

          {/* User Profile Trigger & Popover Menu */}
          <div className="relative" ref={profileMenuRef}>
            <button
              type="button"
              onClick={() => setProfileMenuOpen(!profileMenuOpen)}
              className="flex w-full items-center justify-between rounded-xl p-2 bg-card border border-border hover:bg-muted/60 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5 overflow-hidden">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-mono text-xs font-bold shadow-xs">
                  {avatarChar}
                </div>
                <div className="flex flex-col text-left overflow-hidden">
                  <span className="truncate text-xs font-medium text-foreground">
                    {userEmail}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    Account Profile
                  </span>
                </div>
              </div>
              <span className="text-xs text-muted-foreground font-mono pr-1">•••</span>
            </button>

            {/* Profile Dropdown Popover */}
            {profileMenuOpen && (
              <div className="absolute bottom-12 left-0 right-0 z-50 rounded-xl border border-border bg-popover p-3 shadow-2xl animate-in fade-in zoom-in-95 text-popover-foreground">
                <div className="flex items-center gap-3 border-b border-border pb-2.5 mb-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-mono text-sm font-bold shadow-xs">
                    {avatarChar}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="truncate text-xs font-semibold text-foreground">
                      {userEmail}
                    </span>
                    <span className="text-[10px] font-mono text-emerald-500 font-semibold">
                      ● Active Workspace
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    void signOut();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
                >
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
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
