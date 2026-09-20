import { create } from "zustand";
import { User, onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useChatStore } from "@/store/chatStore";
import { useUsageStore } from "@/store/usageStore";
import { useLocalModelStore } from "@/store/localModelStore";
import { clearAuthCache } from "@/services/api";

interface AuthState {
  user: User | null;
  idToken: string | null;
  loading: boolean;
  initialized: boolean;
  setUser: (user: User | null, idToken: string | null) => void;
  initAuth: () => () => void;
  signOut: () => Promise<void>;
}

function isE2ETestBypassEnabled(): boolean {
  // SAFE TEST-ONLY bypass: must be explicitly enabled via NEXT_PUBLIC_E2E_TEST_MODE=1
  // and never active in production. The env var is only set in Playwright/test runs.
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return false;
  try {
    return typeof window !== "undefined" && (process.env.NEXT_PUBLIC_E2E_TEST_MODE === "1" || (window as unknown as { __NEXUSS_E2E_BYPASS?: boolean }).__NEXUSS_E2E_BYPASS === true);
  } catch { return false; }
}

function getInitialAuthState(): Pick<AuthState, 'user'|'idToken'|'loading'|'initialized'> {
  if (isE2ETestBypassEnabled()) {
    return {
      user: { uid: "e2e-test-user", email: "e2e@test.local", displayName: "E2E Test" } as unknown as User,
      idToken: "e2e-test-token",
      loading: false,
      initialized: true,
    };
  }
  return { user: null, idToken: null, loading: true, initialized: false };
}

export const useAuthStore = create<AuthState>((set) => ({
  ...getInitialAuthState(),

  setUser: (user, idToken) => set({ user, idToken, loading: false }),

  initAuth: () => {
    if (isE2ETestBypassEnabled()) {
      const mockUser = { uid: "e2e-test-user", email: "e2e@test.local", displayName: "E2E Test" } as unknown as User;
      set({ user: mockUser, idToken: "e2e-test-token", loading: false, initialized: true });
      return () => {};
    }
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const token = await firebaseUser.getIdToken();
          set({ user: firebaseUser, idToken: token, loading: false, initialized: true });
        } catch {
          set({ user: firebaseUser, idToken: null, loading: false, initialized: true });
        }
      } else {
        set({ user: null, idToken: null, loading: false, initialized: true });
      }
    });

    return unsubscribe;
  },

  signOut: async () => {
    try {
      await firebaseSignOut(auth);
    } catch (err) {
      console.error("Sign out error:", err);
    } finally {
      clearAuthCache();
      // Clear sensitive auth state.
      set({ user: null, idToken: null, loading: false });
      // Clear all in-memory chat/usage state and account-scoped localStorage
      // so the next account to sign in can never inherit this one's state.
      // IndexedDB is intentionally NOT deleted so the same account keeps its
      // local chats and usage history across logout/login.
      useChatStore.getState().reset(true);
      useUsageStore.getState().resetUsage();
      useLocalModelStore.getState().reset();
    }
  },
}));
