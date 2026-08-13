"use client";

import { useEffect, useRef } from "react";

const AD_SCRIPT_SRC =
  "https://pl30829225.effectivecpmnetwork.com/98/08/a2/9808a269185e74f09da9712dc17c97a4.js";
const AD_SCRIPT_ID = "chat-ad-script";

export default function AdSlot() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Capture the container once; it does not change while mounted.
    const container = containerRef.current;

    // Only load the external ad script on the Chat UI page. Guard against
    // duplicate injection across re-renders and navigation.
    let script = document.getElementById(AD_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = AD_SCRIPT_ID;
      script.src = AD_SCRIPT_SRC;
      script.async = true;
      script.onerror = () => {
        // Silently drop the ad if the network is unavailable.
        document.getElementById(AD_SCRIPT_ID)?.remove();
      };
      document.body.appendChild(script);
    }

    return () => {
      // Clean up the injected script and any ad DOM when leaving the chat page.
      document.getElementById(AD_SCRIPT_ID)?.remove();
      if (container) {
        container.innerHTML = "";
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id="chat-ad-slot"
      aria-label="Advertisement"
      className="shrink-0 w-full overflow-hidden border-t border-border bg-muted/30 px-3 py-2"
    >
      <div className="mx-auto flex w-full max-w-3xl items-center justify-center">
        <div className="flex min-h-[60px] w-full items-center justify-center" />
      </div>
    </div>
  );
}