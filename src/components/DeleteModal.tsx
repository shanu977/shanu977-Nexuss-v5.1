"use client";

import Modal from "@/components/Modal";
import { useChatStore } from "@/store";

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string;
  chatTitle: string;
}

export default function DeleteModal({
  isOpen,
  onClose,
  chatId,
  chatTitle,
}: DeleteModalProps) {
  const deleteChat = useChatStore((s) => s.deleteChat);

  const handleDelete = async () => {
    await deleteChat(chatId);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Delete conversation?">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Are you sure you want to delete this conversation? This action cannot be undone.
        </p>

        <div className="rounded-xl border border-border bg-muted/50 p-3">
          <p className="text-xs font-semibold text-foreground truncate font-sans">
            {chatTitle || "Untitled conversation"}
          </p>
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
            type="button"
            onClick={() => void handleDelete()}
            className="rounded-xl bg-destructive text-destructive-foreground px-4 py-2 text-xs font-semibold hover:bg-destructive/90 transition-colors cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
