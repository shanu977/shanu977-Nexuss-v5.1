"use client";

import { useEffect, useRef } from "react";

// Adsterra Native Banner placement. The script URL and container id are the
// exact values supplied by Adsterra and must not be changed; the script drives
// the ad content and only looks for a single live container with this id.
const ADSTERRA_SCRIPT_SRC =
  "https://pl30925652.effectivecpmnetwork.com/9434692e0f33ebcfc9c000e143262e75/invoke.js";
const ADSTERRA_CONTAINER_ID =
  "container-9434692e0f33ebcfc9c000e143262e75";
const ADSTERRA_PLACEMENT_KEY =
  "9434692e0f33ebcfc9c000e143262e75";
const SCRIPT_ID = `adsterra-script-${ADSTERRA_CONTAINER_ID}`;

// Adsterra's invoke script records each placement key in a global array and
// only fills a placement once per page session; a re-run of the script for an
// already-registered key skips the render and leaves the container empty.
// Reset every such registry (matched by the placement key so it stays robust
// against Adsterra renaming the obfuscated array name) before injecting a
// fresh copy of the script so each mount can initialize the banner again.
function clearAdsterraRegistry(): void {
  const win = window as unknown as Record<string, unknown>;
  const keys = Object.keys(win);
  for (const key of keys) {
    const value = win[key];
    if (Array.isArray(value) && value.includes(ADSTERRA_PLACEMENT_KEY)) {
      win[key] = [];
    }
  }
}

function loadAdsterraScript(): void {
  document.getElementById(SCRIPT_ID)?.remove();
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = ADSTERRA_SCRIPT_SRC;
  script.async = true;
  script.setAttribute("data-cfasync", "false");
  document.head.appendChild(script);
}

/**
 * Renders the Adsterra Native Banner container and (re)initializes the ad on
 * every mount. The container is committed before the effect runs, so the async
 * script always finds the slot to fill. Only one container with the placement
 * id is kept live at a time.
 */
export default function AdsterraNativeBanner() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Guard against duplicate container ids from any stale mount: the ad
    // script fills the first node it finds with this id, so a duplicate would
    // either shadow the live slot or be filled instead of it.
    const existing = document.getElementById(ADSTERRA_CONTAINER_ID);
    if (existing && existing !== el) existing.remove();

    // Start from a clean slot so re-mounts never stack old fill content.
    el.innerHTML = "";
    clearAdsterraRegistry();
    loadAdsterraScript();
  }, []);

  return (
    <div
      id={ADSTERRA_CONTAINER_ID}
      ref={containerRef}
      className="adsterra-native-banner w-full max-w-full overflow-hidden"
      aria-hidden="true"
    />
  );
}
