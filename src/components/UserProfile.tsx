"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  LogOutIcon,
  SettingsIcon,
  UserIcon
} from "@/components/icons";
import { ESCAPE_GUARD_ATTR } from "@/utils/escapeGuard";

interface UserProfileProps {
  email: string;
  avatarChar: string;
  /** Display name when the auth provider supplies one. */
  name?: string;
  /** Name of the connected local workspace/folder, when any. */
  workspaceName?: string | null;
  onOpenAccount?: () => void;
  onOpenSettings?: () => void;
  onSignOut?: () => void;
}

const menuItemClass =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-muted transition-colors cursor-pointer text-left";

export default function UserProfile({
  email,
  avatarChar,
  name,
  workspaceName,
  onOpenAccount,
  onOpenSettings,
  onSignOut
}: UserProfileProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Move focus into the menu when it opens so keyboard users land on it.
  useEffect(() => {
    if (!open) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    firstItem?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const displayName = name?.trim() || email;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open account menu"
        className="flex w-full items-center gap-2.5 rounded-xl p-2 bg-card border border-border text-left transition-colors hover:bg-muted/50 cursor-pointer"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-xs">
          {avatarChar}
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-foreground">{email}</span>
          <span className="text-[10px] text-emerald-500 font-semibold">Active Workspace</span>
        </div>
        <ChevronDownIcon
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account menu"
          {...{ [ESCAPE_GUARD_ATTR]: "" }}
          className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl font-sans animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-xs">
              {avatarChar}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold text-foreground">{displayName}</span>
              <span className="truncate text-[11px] text-muted-foreground">{email}</span>
            </div>
          </div>

          <div className="mx-2 my-1 h-px bg-border" />

          <div className="px-2 pb-1.5">
            <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-500">
              Active Workspace
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {workspaceName?.trim() || "No folder connected"}
            </p>
          </div>

          <div className="mx-2 my-1 h-px bg-border" />

          <div className="space-y-0.5">
            {onOpenAccount && (
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onOpenAccount();
                }}
              >
                <UserIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>Account</span>
              </button>
            )}
            {onOpenSettings && (
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onOpenSettings();
                }}
              >
                <SettingsIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>Settings</span>
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                role="menuitem"
                className={`${menuItemClass} text-destructive hover:bg-destructive/10`}
                onClick={() => {
                  close();
                  onSignOut();
                }}
              >
                <LogOutIcon className="h-3.5 w-3.5 shrink-0" />
                <span>Sign out</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
