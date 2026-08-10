import { create } from "zustand";
import { User, onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useChatStore } from "@/store/chatStore";
import { useUsageStore } from "@/store/usageStore";

interface AuthState {
  user: User | null;
  idToken: string | null;
  loading: boolean;
  initialized: boolean;
  setUser: (user: User | null, idToken: string | null) => void;
  initAuth: () => () => void;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  idToken: null,
  loading: true,
  initialized: false,

  setUser: (user, idToken) => set({ user, idToken, loading: false }),

  initAuth: () => {
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
      // Clear sensitive auth state.
      set({ user: null, idToken: null, loading: false });
      // Clear all in-memory chat/usage state and account-scoped localStorage
      // so the next account to sign in can never inherit this one's state.
      // IndexedDB is intentionally NOT deleted so the same account keeps its
      // local chats and usage history across logout/login.
      useChatStore.getState().reset(true);
      useUsageStore.getState().resetUsage();
    }
  },
}));
