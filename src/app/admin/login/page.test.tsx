import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    signInWithEmailAndPassword: vi.fn().mockResolvedValue({}),
    signInWithPopup: vi.fn().mockResolvedValue({}),
    isAdmin: vi.fn().mockResolvedValue(true),
    replace: vi.fn(),
    sendPasswordResetCode: vi.fn().mockResolvedValue({}),
    confirmPasswordReset: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signInWithPopup: mocks.signInWithPopup,
  onAuthStateChanged: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/firebase", () => ({
  auth: {},
  googleProvider: {},
}));

vi.mock("@/services/admin", () => ({
  adminApi: { isAdmin: mocks.isAdmin },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AdminLoginPage from "@/app/admin/login/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminLoginPage", () => {
  it("signs in with email and redirects when the backend confirms admin", async () => {
    render(<AdminLoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in with email/i }));

    await vi.waitFor(() => {
      expect(mocks.signInWithEmailAndPassword).toHaveBeenCalledWith({}, "admin@example.com", "secret");
      expect(mocks.isAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.replace).toHaveBeenCalledWith("/admin/dashboard");
    });
  });

  it("shows an error when the account is not an admin", async () => {
    mocks.isAdmin.mockResolvedValue(false);
    render(<AdminLoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in with email/i }));

    expect(
      await screen.findByText("Signed in, but this account does not have admin access.")
    ).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("renders Google sign-in and the restricted-access notice", () => {
    render(<AdminLoginPage />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByText(/access requires an administrator role/i)).toBeInTheDocument();
  });
});