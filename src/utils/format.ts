/** Shared formatting helpers for the Admin UI. Kept pure for easy testing. */

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  return value.toLocaleString("en-US");
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Format epoch-milliseconds as a readable date-time (e.g. Aug 12, 2026 • 3:41 PM). */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  return (
    d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }) +
    " • " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

/** Short date-only form (e.g. Aug 12, 2026). */
export function formatDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Render a boolean-ish setting value as a friendly label. */
export function formatSettingValue(setting: {
  value: string;
  value_type: string;
}): string {
  if (setting.value_type === "boolean") {
    return setting.value === "true" ? "Enabled" : "Disabled";
  }
  return setting.value;
}
