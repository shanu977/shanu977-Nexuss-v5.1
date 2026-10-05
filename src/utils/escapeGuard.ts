/**
 * Escape-key arbitration between nested surfaces.
 *
 * The app has several stacked overlays (sidebar drawer, settings modal,
 * profile popover, confirmation dialogs) that each listen for Escape on
 * `window`. Because a parent registers its listener before a child, the
 * parent always sees the key first — so a parent must yield while a nested
 * surface is on screen.
 *
 * Nested surfaces mark their root element with `data-escape-guard` while
 * they are open; parents call this helper before acting on Escape.
 */
export const ESCAPE_GUARD_ATTR = "data-escape-guard";

export function hasNestedEscapeOverlay(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector(`[${ESCAPE_GUARD_ATTR}]`) !== null;
}
