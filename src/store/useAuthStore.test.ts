import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const signOut = vi.fn().mockResolvedValue(undefined);
  const chatReset = vi.fn();
  const usageReset = vi.fn();
  return { signOut, chatReset, usageReset };
});

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn(() => vi.fn()),
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
  EmailAuthProvider: class {},
  getAuth: vi.fn(() => ({}))
}));

vi.mock("@/lib/firebase", () => ({
  auth: {},
  app: {}
}));

vi.mock("@/store/chatStore", () => ({
  useChatStore: { getState: () => ({ reset: mocks.chatReset }) }
}));

vi.mock("@/store/usageStore", () => ({
  useUsageStore: { getState: () => ({ resetUsage: mocks.usageReset }) }
}));

import { useAuthStore } from "@/store/useAuthStore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signOut.mockResolvedValue(undefined);
  useAuthStore.setState({
    user: { uid: "user-a" } as never,
    idToken: "token",
    loading: false,
    initialized: true
  });
});

describe("useAuthStore signOut", () => {
  it("calls Firebase signOut and clears auth state", async () => {
    await useAuthStore.getState().signOut();

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().idToken).toBeNull();
  });

  it("clears in-memory chat and usage state on logout", async () => {
    await useAuthStore.getState().signOut();

    expect(mocks.chatReset).toHaveBeenCalledWith(true);
    expect(mocks.usageReset).toHaveBeenCalledTimes(1);
  });

  it("still clears auth/state if Firebase signOut rejects", async () => {
    mocks.signOut.mockRejectedValueOnce(new Error("net"));

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().user).toBeNull();
    expect(mocks.chatReset).toHaveBeenCalledWith(true);
    expect(mocks.usageReset).toHaveBeenCalledTimes(1);
  });
});
