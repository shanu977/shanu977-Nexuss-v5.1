"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/store";
import { useAuthStore } from "@/store/useAuthStore";
import { useLocalModelStore } from "@/store/localModelStore";
import Spinner from "@/components/Spinner";

export default function Hydrate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const user = useAuthStore((s) => s.user);
  const uid = user?.uid ?? null;
  // Guard against StrictMode double-mount and rapid uid changes.
  const lastHydratedUid = useRef<string | null | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Use uid (not user object) to avoid re-hydrating when user reference changes but uid is same.
    // Skip duplicate hydrate for same uid.
    if (lastHydratedUid.current === uid && ready) return;
    lastHydratedUid.current = uid;

    const init = async () => {
      const t0 = typeof performance !== "undefined" ? performance.now() : 0;
      if (typeof performance !== "undefined" && performance.mark) {
        try {
          performance.mark("hydrate-component-start");
        } catch {}
      }
      try {
        // hydrate() now resolves immediately after local IndexedDB metadata
        // (chats + selected messages + theme) and does NOT block on remote
        // Supabase settings fetch. This is the correct fast path for the spinner.
        await Promise.all([
          useChatStore.getState().hydrate(),
          useLocalModelStore.getState().hydrate(),
        ]);
      } catch (e) {
        // Ensure spinner never gets stuck on IndexedDB failure.
        // hydrate() already sets error state, but we must still show UI.
        console.error("[Hydrate] hydrate failed:", e);
      } finally {
        if (mounted.current) setReady(true);
        if (process.env.NODE_ENV !== "production") {
          const dur = typeof performance !== "undefined" ? performance.now() - t0 : 0;
          // eslint-disable-next-line no-console
          console.debug(`[Hydrate] uid=${uid ?? "null"} ready in ${dur.toFixed(1)}ms`);
        }
        if (typeof performance !== "undefined" && performance.mark) {
          try {
            performance.mark("hydrate-component-end");
            if (performance.measure) performance.measure("hydrate-component", "hydrate-component-start", "hydrate-component-end");
          } catch {}
        }
      }
    };
    // Reset ready briefly when uid changes so spinner shows only if needed,
    // but avoid flicker when hydration is already fast.
    // We keep ready true for same uid deduped above, otherwise re-init.
    setReady(false);
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally key on uid, not user object or hydrate fn
  }, [uid]);

  if (!ready) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <Spinner className="h-8 w-8 text-primary" />
        <p className="text-sm text-muted-foreground">Loading your chats...</p>
      </div>
    );
  }

  return <>{children}</>;
}
