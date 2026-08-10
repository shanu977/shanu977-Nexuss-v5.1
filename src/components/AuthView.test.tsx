import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { Mock } from "vitest";
import "@testing-library/jest-dom/vitest";

import AuthView from "./AuthView";
import { request, ApiError } from "../services/api";
import { signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";

vi.mock("firebase/auth", () => ({
  signInWithPopup: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../lib/firebase", () => ({
  auth: { currentUser: null },
  googleProvider: {},
}));

vi.mock("../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/api")>();
  return { ...actual, request: vi.fn() };
});

const requestMock = request as unknown as Mock;
const emailLoginMock = signInWithEmailAndPassword as unknown as Mock;
const googleSignInMock = signInWithPopup as unknown as Mock;

const EMAIL = "user@example.com";

function passwordAccountStatus() {
  return { exists: true, providers: ["password"], has_password: true };
}

function googleOnlyStatus() {
  return { exists: true, providers: ["google.com"], has_password: false };
}

beforeEach(() => {
  requestMock.mockReset();
  emailLoginMock.mockReset();
  googleSignInMock.mockReset();
  emailLoginMock.mockResolvedValue({ user: { uid: "uid-A" } });
  googleSignInMock.mockResolvedValue({ user: { uid: "uid-A" } });
  requestMock.mockImplementation(async (path: string) => {
    if (path === "/auth/user-status") return passwordAccountStatus();
    if (path === "/auth/otp/send") {
      return { message: "Verification code sent to email.", cooldown_seconds: 60 };
    }
    if (path === "/auth/otp/verify") {
      return { verified: true, verification_token: "tok-123" };
    }
    if (path === "/auth/reset-password") {
      return { success: true, message: "Password reset successfully." };
    }
    throw new ApiError(404, "unexpected path");
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function gotoForgot() {
  render(<AuthView />);
  fireEvent.click(screen.getByText("Forgot Password?"));
}

async function submitForgotEmail(email: string = EMAIL) {
  fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByText("Send OTP"));
  await waitFor(() => {
    expect(requestMock).toHaveBeenCalledWith(
      "/auth/otp/send",
      expect.anything()
    );
  });
}

describe("Forgot Password UI", () => {
  it("shows the Forgot Password button on the login view", () => {
    render(<AuthView />);
    expect(screen.getByText("Forgot Password?")).toBeInTheDocument();
  });

  it("opens the registration page from login and returns to login", async () => {
    render(<AuthView />);
    fireEvent.click(screen.getByText("Create an account"));

    expect(
      await screen.findByRole("heading", { name: "Create Account" })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter username")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Google" })
    ).toBeInTheDocument();

    // Existing users can always return to the login page.
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(
      screen.getByText("Sign in to NEXUSS")
    ).toBeInTheDocument();
  });

  it("opens the email step and can go back to login", () => {
    gotoForgot();
    expect(screen.getByText("Send OTP")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Back to Login"));
    expect(screen.getByText("Sign in to NEXUSS")).toBeInTheDocument();
  });

  it("sends the OTP via the existing endpoint and advances to the OTP step", async () => {
    gotoForgot();
    await submitForgotEmail();

    expect(requestMock).toHaveBeenCalledWith(
      "/auth/otp/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: EMAIL, purpose: "reset_password" }),
      })
    );
    // OTP step visible with resend cooldown running.
    expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    expect(screen.getByText("Resend code in 60s")).toBeInTheDocument();
  });

  it("does not send an OTP when the email has no account", async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/auth/user-status") {
        return { exists: false, providers: [], has_password: false };
      }
      throw new ApiError(404, "unexpected path");
    });

    gotoForgot();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: EMAIL },
    });
    fireEvent.click(screen.getByText("Send OTP"));

    await waitFor(() => {
      expect(
        screen.getByText("No account found with this email address.")
      ).toBeInTheDocument();
    });
    // The OTP must NOT be sent for a nonexistent account.
    expect(requestMock).not.toHaveBeenCalledWith(
      "/auth/otp/send",
      expect.anything()
    );
  });

  it("routes Google-only accounts to the existing Set Password flow (no duplicate account)", async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/auth/user-status") return googleOnlyStatus();
      throw new ApiError(404, "unexpected path");
    });

    gotoForgot();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: EMAIL },
    });
    fireEvent.click(screen.getByText("Send OTP"));

    await waitFor(() => {
      expect(screen.getByText("Account Linking Required")).toBeInTheDocument();
    });
    // The OTP must NOT be sent for a google-only account.
    expect(requestMock).not.toHaveBeenCalledWith(
      "/auth/otp/send",
      expect.anything()
    );
  });

  it("verifies a correct OTP and advances to the new-password step", async () => {
    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "555555" },
    });
    fireEvent.click(screen.getByText("Verify OTP"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/otp/verify",
        expect.objectContaining({
          body: JSON.stringify({ email: EMAIL, otp: "555555" }),
        })
      );
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });
  });

  it("shows an error and stays on the OTP step for a wrong code", async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/auth/user-status") return passwordAccountStatus();
      if (path === "/auth/otp/send") {
        return { message: "Verification code sent to email.", cooldown_seconds: 60 };
      }
      if (path === "/auth/otp/verify") {
        throw new ApiError(400, "Invalid verification code.");
      }
      throw new ApiError(404, "unexpected path");
    });

    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByText("Verify OTP"));

    await waitFor(() => {
      expect(screen.getByText("Invalid verification code.")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });
  });

  it("never persists the OTP to localStorage or IndexedDB", async () => {
    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "555555" },
    });
    fireEvent.click(screen.getByText("Verify OTP"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });
    const stored = { ...localStorage } as Record<string, string>;
    const values = Object.values(stored).join(" ");
    expect(values).not.toContain("555555");
  });

  it("rejects a short new password", async () => {
    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "555555" } });
    fireEvent.click(screen.getByText("Verify OTP"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });

    const form = screen.getByPlaceholderText("At least 6 characters").closest("form");
    fireEvent.change(screen.getByPlaceholderText("At least 6 characters"), {
      target: { value: "123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Re-enter password"), {
      target: { value: "123" },
    });
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Password must be at least 6 characters long.")
    ).toBeInTheDocument();
    // No reset request is made with an invalid password.
    expect(requestMock).not.toHaveBeenCalledWith(
      "/auth/reset-password",
      expect.anything()
    );
  });

  it("rejects mismatched passwords", async () => {
    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "555555" } });
    fireEvent.click(screen.getByText("Verify OTP"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });

    const form = screen.getByPlaceholderText("At least 6 characters").closest("form");
    fireEvent.change(screen.getByPlaceholderText("At least 6 characters"), {
      target: { value: "correct-pass" },
    });
    fireEvent.change(screen.getByPlaceholderText("Re-enter password"), {
      target: { value: "different-pass" },
    });
    fireEvent.submit(form!);

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalledWith(
      "/auth/reset-password",
      expect.anything()
    );
  });

  it("resets the password and logs the user in with the new password", async () => {
    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "555555" } });
    fireEvent.click(screen.getByText("Verify OTP"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });

    const form = screen.getByPlaceholderText("At least 6 characters").closest("form");
    fireEvent.change(screen.getByPlaceholderText("At least 6 characters"), {
      target: { value: "newpass123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Re-enter password"), {
      target: { value: "newpass123" },
    });
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/reset-password",
        expect.objectContaining({
          body: JSON.stringify({
            email: EMAIL,
            verification_token: "tok-123",
            password: "newpass123",
          }),
        })
      );
    });
    // Immediately signs in with the new password.
    await waitFor(() => {
      expect(emailLoginMock).toHaveBeenCalledWith(
        expect.anything(),
        EMAIL,
        "newpass123"
      );
    });
  });

  it("shows an error banner when the reset endpoint rejects", async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/auth/user-status") return passwordAccountStatus();
      if (path === "/auth/otp/send") {
        return { message: "Verification code sent to email.", cooldown_seconds: 60 };
      }
      if (path === "/auth/otp/verify") {
        return { verified: true, verification_token: "tok-123" };
      }
      if (path === "/auth/reset-password") {
        throw new ApiError(400, "Password reset failed. Please try again.");
      }
      throw new ApiError(404, "unexpected path");
    });

    gotoForgot();
    await submitForgotEmail();

    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "555555" } });
    fireEvent.click(screen.getByText("Verify OTP"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("At least 6 characters")).toBeInTheDocument();
    });

    const form = screen.getByPlaceholderText("At least 6 characters").closest("form");
    fireEvent.change(screen.getByPlaceholderText("At least 6 characters"), {
      target: { value: "newpass123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Re-enter password"), {
      target: { value: "newpass123" },
    });
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Password reset failed. Please try again.")
    ).toBeInTheDocument();
    // No auto-login when the reset failed.
    expect(emailLoginMock).not.toHaveBeenCalled();
  });
});
