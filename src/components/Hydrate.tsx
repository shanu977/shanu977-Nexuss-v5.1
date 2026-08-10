"use client";

import { useEffect, useState } from "react";
import { useChatStore } from "@/store";
import { useAuthStore } from "@/store/useAuthStore";
import Spinner from "@/components/Spinner";

export default function Hydrate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    const init = async () => {
      // Wait for Firebase auth to be fully initialized so we know the UID
      // before touching IndexedDB. hydrate() loads zero account-owned chats
      // when there is no authenticated user.
      await useChatStore.getState().hydrate();
      setReady(true);
    };
    init();
  }, [user]);

  if (!ready) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <Spinner className="h-8 w-8 text-primary" />
        <p className="text-sm text-muted-foreground">Loading your chats...</p>
      </div>
    );
  }

  return <>{children}</>;
}
