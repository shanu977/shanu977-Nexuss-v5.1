const OPTIONS = ["7D", "30D", "3M", "1Y"] as const;
export type DateRangeValue = (typeof OPTIONS)[number];

interface DateRangeSelectorProps {
  selected: string;
  onChange: (value: string) => void;
}

const LABELS: Record<string, string> = {
  "7D": "7 Days",
  "30D": "30 Days",
  "3M": "3 Months",
  "1Y": "1 Year",
};

export function DateRangeSelector({ selected, onChange }: DateRangeSelectorProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: "3px",
        backgroundColor: "var(--bg-app)",
        border: "1px solid var(--border-color)",
        borderRadius: "var(--radius-md)",
        gap: "2px",
      }}
    >
      {OPTIONS.map((opt) => {
        const isSelected = selected === opt;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            style={{
              padding: "4px 12px",
              fontSize: "0.75rem",
              fontWeight: 600,
              borderRadius: "var(--radius-sm)",
              color: isSelected ? "var(--text-primary)" : "var(--text-muted)",
              backgroundColor: isSelected ? "var(--bg-card)" : "transparent",
              border: isSelected ? "1px solid var(--border-color)" : "1px solid transparent",
              transition: "all var(--transition-fast)",
            }}
          >
            {LABELS[opt]}
          </button>
        );
      })}
    </div>
  );
}
