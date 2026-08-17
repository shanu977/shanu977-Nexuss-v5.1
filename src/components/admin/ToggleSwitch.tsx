interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function ToggleSwitch({ checked, onChange, label, disabled = false }: ToggleSwitchProps) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "12px",
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => !disabled && onChange(!checked)}
        style={{
          width: "44px",
          height: "24px",
          borderRadius: "var(--radius-full)",
          backgroundColor: checked ? "var(--accent-primary)" : "#27272a",
          position: "relative",
          transition: "background-color var(--transition-fast)",
          boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
          border: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: 0,
        }}
      >
        <div
          style={{
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            backgroundColor: "#ffffff",
            position: "absolute",
            top: "3px",
            left: checked ? "23px" : "3px",
            transition: "left var(--transition-fast)",
            boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
          }}
        />
      </button>
      {label && (
        <span style={{ fontSize: "0.88rem", fontWeight: 500, color: "var(--text-primary)" }}>
          {label}
        </span>
      )}
    </label>
  );
}
