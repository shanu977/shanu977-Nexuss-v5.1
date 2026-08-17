import { AlertTriangle, X } from "lucide-react";

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  isLoading?: boolean;
}

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Are you sure?",
  message = "This action cannot be undone.",
  confirmText = "Confirm",
  cancelText = "Cancel",
  isDanger = true,
  isLoading = false,
}: ConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div
        className="admin-glass-panel admin-animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "440px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "var(--radius-full)",
                backgroundColor: isDanger ? "var(--color-danger-bg)" : "var(--color-warning-bg)",
                color: isDanger ? "var(--color-danger)" : "var(--color-warning)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={20} />
            </div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--text-primary)" }}>
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ color: "var(--text-muted)", padding: "4px" }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {message}
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
          <button
            onClick={onClose}
            disabled={isLoading}
            style={{
              padding: "8px 16px",
              fontSize: "0.85rem",
              fontWeight: 500,
              borderRadius: "var(--radius-md)",
              color: "var(--text-secondary)",
              backgroundColor: "var(--bg-app)",
              border: "1px solid var(--border-color)",
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            style={{
              padding: "8px 18px",
              fontSize: "0.85rem",
              fontWeight: 600,
              borderRadius: "var(--radius-md)",
              color: "#ffffff",
              backgroundColor: isDanger ? "var(--color-danger)" : "var(--accent-primary)",
              opacity: isLoading ? 0.7 : 1,
              transition: "all var(--transition-fast)",
            }}
          >
            {isLoading ? "Processing..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
