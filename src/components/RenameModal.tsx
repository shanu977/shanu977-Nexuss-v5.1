"use client";

import { useState, useEffect } from "react";
import Modal from "@/components/Modal";
import { useChatStore } from "@/store";

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string;
  currentTitle: string;
}

export default function RenameModal({
  isOpen,
  onClose,
  chatId,
  currentTitle,
}: RenameModalProps) {
  const [title, setTitle] = useState(currentTitle);
  const renameChat = useChatStore((s) => s.renameChat);

  useEffect(() => {
    setTitle(currentTitle);
  }, [currentTitle, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed && trimmed !== currentTitle) {
      await renameChat(chatId, trimmed);
    }
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Rename conversation">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground font-mono">
            Conversation name
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3.5 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:ring-2 focus:ring-ring font-sans"
            autoFocus
            required
          />
        </div>
        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-input bg-background px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || title.trim() === currentTitle}
            className="rounded-xl bg-primary text-primary-foreground px-4 py-2 text-xs font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity cursor-pointer"
          >
            Save Changes
          </button>
        </div>
      </form>
    </Modal>
  );
}
