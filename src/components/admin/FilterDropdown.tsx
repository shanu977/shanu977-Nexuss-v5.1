import { Filter } from "lucide-react";

interface FilterOption {
  label?: string;
  value: string;
}

interface FilterDropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<string | FilterOption>;
  label?: string;
}

export function FilterDropdown({ value, onChange, options = [], label = "Filter" }: FilterDropdownProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <Filter
          size={14}
          style={{ position: "absolute", left: "10px", color: "var(--text-muted)", pointerEvents: "none" }}
        />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          style={{
            padding: "8px 28px 8px 30px",
            fontSize: "0.85rem",
            color: "var(--text-primary)",
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-md)",
            outline: "none",
            appearance: "none",
            cursor: "pointer",
          }}
        >
          {options.map((opt) => {
            const resolved = typeof opt === "string" ? { value: opt, label: opt } : opt;
            return (
              <option key={resolved.value} value={resolved.value}>
                {resolved.label || resolved.value}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}
