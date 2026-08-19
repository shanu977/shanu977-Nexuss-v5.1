"use client";

import { useEffect, useRef } from "react";

// Adsterra Native Banner placement. The script URL and container id are the
// exact values supplied by Adsterra and must not be changed; the script drives
// the ad content and only looks for a single live container with this id.
const ADSTERRA_SCRIPT_SRC =
  "https://pl30925652.effectivecpmnetwork.com/9434692e0f33ebcfc9c000e143262e75/invoke.js";
const ADSTERRA_CONTAINER_ID =
  "container-9434692e0f33ebcfc9c000e143262e75";

// Module-level bookkeeping so the external script is injected exactly once per
// live mount cycle and is removed again when the last mounted instance goes
// away (which lets a later mount re-inject it and re-fill a fresh container
// without ever running duplicate copies or leaving stale nodes behind).
let injectedScript: HTMLScriptElement | null = null;
let liveMounts = 0;

function ensureScriptLoaded(): void {
  if (injectedScript && injectedScript.isConnected) return;
  const script = document.createElement("script");
  script.src = ADSTERRA_SCRIPT_SRC;
  script.async = true;
  script.setAttribute("data-cfasync", "false");
  injectedScript = script;
  document.head.appendChild(script);
}

function releaseScript(): void {
  if (injectedScript && injectedScript.isConnected) {
    injectedScript.remove();
  }
  injectedScript = null;
}

/**
 * Renders the Adsterra Native Banner container and loads its invoke script.
 *
 * The container is committed to the DOM before the effect runs, so the async
 * script finds the slot it is supposed to fill. Only one container with the
 * placement id is ever kept live (the invoke script targets that id), and the
 * script is never re-injected on ordinary React re-renders.
 */
export default function AdsterraNativeBanner() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    liveMounts += 1;
    // Guard against duplicate container ids from any stale mount: the ad
    // script fills the first node it finds with this id, so a duplicate would
    // either shadow the live slot or be filled instead of it.
    const existing = document.getElementById(ADSTERRA_CONTAINER_ID);
    if (existing && existing !== el) existing.remove();

    // Start from a clean slot so re-mounts never stack old fill content.
    el.innerHTML = "";
    ensureScriptLoaded();

    return () => {
      liveMounts -= 1;
      if (liveMounts <= 0) {
        releaseScript();
      }
    };
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