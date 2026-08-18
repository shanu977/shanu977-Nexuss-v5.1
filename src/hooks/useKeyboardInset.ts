"use client";

import { useEffect, useState } from "react";

/**
 * Tracks how much of the layout viewport is currently covered by the on-screen
 * keyboard, in pixels.
 *
 * The software keyboard shrinks the *visual* viewport but not the layout
 * viewport on iOS Safari, so a fixed-height chat layout would otherwise hide
 * the composer behind the keyboard. On Chrome for Android the layout viewport
 * already resizes (`interactive-widget=resizes-content`), so the gap is ~0 and
 * no extra offset is applied. Returns 0 on desktop and when visualViewport is
 * unavailable.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;

    const update = () => {
      const gap = window.innerHeight - vv.height;
      setInset(gap > 0 ? gap : 0);
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
