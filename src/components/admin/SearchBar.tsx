import { Search } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder = "Search..." }: SearchBarProps) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        width: "100%",
        maxWidth: "320px",
      }}
    >
      <Search
        size={16}
        style={{ position: "absolute", left: "12px", color: "var(--text-muted)", pointerEvents: "none" }}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          width: "100%",
          padding: "8px 12px 8px 36px",
          fontSize: "0.85rem",
          color: "var(--text-primary)",
          backgroundColor: "var(--bg-input)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-md)",
          outline: "none",
          transition: "border-color var(--transition-fast)",
        }}
        onFocus={(e) => (e.target.style.borderColor = "var(--accent-primary)")}
        onBlur={(e) => (e.target.style.borderColor = "var(--border-color)")}
      />
    </div>
  );
}
