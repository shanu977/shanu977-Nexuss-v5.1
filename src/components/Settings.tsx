"use client";

import { useEffect, useRef } from "react";
import SettingsContent from "@/components/SettingsContent";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Settings({ isOpen, onClose }: SettingsProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handleClick);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs font-sans animate-in fade-in duration-150">
      <div
        ref={panelRef}
        className="w-full max-w-[440px] flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl backdrop-blur-xl animate-in zoom-in-95"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 bg-muted/50">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold tracking-wider text-foreground uppercase">
              SETTINGS
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SettingsContent />
        </div>
      </div>
    </div>
  );
}
