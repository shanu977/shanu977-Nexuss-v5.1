"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, SettingsIcon, LogOutIcon } from "@/components/icons";

interface UserMenuProps {
  email: string;
  avatarChar: string;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export default function UserMenu({
  email,
  avatarChar,
  onOpenSettings,
  onSignOut
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-xl p-2 bg-card border border-border transition-colors hover:bg-muted/60 cursor-pointer"
      >
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-xs">
            {avatarChar}
          </div>
          <div className="flex flex-col items-start overflow-hidden">
            <span className="max-w-[140px] truncate text-xs font-medium text-foreground">
              {email}
            </span>
            <span className="text-[10px] text-muted-foreground">Account</span>
          </div>
        </div>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-12 left-0 right-0 z-50 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-2xl animate-fade-in text-popover-foreground"
        >
          <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
              {avatarChar}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold text-foreground">
                {email}
              </span>
              <span className="text-[10px] text-emerald-500 font-semibold">
                Active Workspace
              </span>
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
          >
            <SettingsIcon className="h-4 w-4 text-muted-foreground" />
            <span>Settings</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 cursor-pointer"
          >
            <LogOutIcon className="h-4 w-4" />
            <span>Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
