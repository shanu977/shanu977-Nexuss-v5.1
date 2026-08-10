"use client";

import { useEffect, ReactNode } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import Spinner from "./Spinner";

export default function AuthProvider({ children }: { children: ReactNode }) {
  const { initAuth, initialized } = useAuthStore();

  useEffect(() => {
    const unsubscribe = initAuth();
    return () => unsubscribe();
  }, [initAuth]);

  if (!initialized) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gray-900 text-white">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8 text-blue-500" />
          <p className="text-sm font-medium text-gray-400">Initializing session...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
