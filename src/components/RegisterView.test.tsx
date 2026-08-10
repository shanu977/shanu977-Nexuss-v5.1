import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { Mock } from "vitest";
import "@testing-library/jest-dom/vitest";

import RegisterView from "./RegisterView";
import { auth, googleProvider } from "../lib/firebase";
import { request, ApiError } from "../services/api";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithPopup,
  updateProfile,
} from "firebase/auth";

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  signInWithPopup: vi.fn(),
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

const createAccountMock = createUserWithEmailAndPassword as unknown as Mock;
const sendVerificationMock = sendEmailVerification as unknown as Mock;
const updateProfileMock = updateProfile as unknown as Mock;
const googleSignInMock = signInWithPopup as unknown as Mock;
const requestMock = request as unknown as Mock;

const onBackToLogin = vi.fn();
const onExistingAccountLogin = vi.fn();
const onGoogleOnlySetPassword = vi.fn();

const EMAIL = "newuser@example.com";

const STATUS_NEW_EMAIL = { exists: false, providers: [], has_password: false };
const STATUS_PASSWORD = {
  exists: true,
  providers: ["password"],
  has_password: true,
};
const STATUS_GOOGLE_ONLY = {
  exists: true,
  providers: ["google.com"],
  has_password: false,
};
const STATUS_GOOGLE_PASSWORD = {
  exists: true,
  providers: ["google.com", "password"],
  has_password: true,
};

const SEND_OTP_OK = { message: "sent", cooldown_seconds: 60 };
const VERIFY_OTP_OK = { verified: true, verification_token: "tok" };

function fillForm(overrides: {
  username?: string;
  email?: string;
  password?: string;
  confirm?: string;
} = {}) {
  const { username = "alice", email = EMAIL, password = "password1", confirm = "password1" } =
    overrides;
  fireEvent.change(screen.getByPlaceholderText("Enter username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter email"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm password"), {
    target: { value: confirm },
  });
}

function submitForm() {
  // Submit the form directly so jsdom constraint validation (required /
  // minLength) never blocks the submit event before our JS validation runs.
  const form = screen.getByPlaceholderText("Enter username").closest("form");
  fireEvent.submit(form!);
}

function enterOtp(code = "123456") {
  fireEvent.change(screen.getByPlaceholderText("123456"), {
    target: { value: code },
  });
}

function submitOtp() {
  const form = screen.getByPlaceholderText("123456").closest("form");
  fireEvent.submit(form!);
}

function countSendOtpCalls() {
  return requestMock.mock.calls.filter((c) => c[0] === "/auth/otp/send").length;
}

function mockRequest(handlers: {
  userStatus?: unknown;
  sendOtp?: unknown;
  verifyOtp?: unknown;
}) {
  requestMock.mockImplementation(async (path: string) => {
    const handler =
      (path === "/auth/user-status" && handlers.userStatus) ||
      (path === "/auth/otp/send" && handlers.sendOtp) ||
      (path === "/auth/otp/verify" && handlers.verifyOtp);
    if (handler === undefined) {
      throw new ApiError(404, "unexpected path");
    }
    if (handler instanceof Error) {
      throw handler;
    }
    return handler;
  });
}

beforeEach(() => {
  createAccountMock.mockReset();
  sendVerificationMock.mockReset();
  updateProfileMock.mockReset();
  googleSignInMock.mockReset();
  requestMock.mockReset();
  onBackToLogin.mockReset();
  onExistingAccountLogin.mockReset();
  onGoogleOnlySetPassword.mockReset();

  createAccountMock.mockResolvedValue({
    user: { uid: "uid-new", email: EMAIL },
  });
  sendVerificationMock.mockResolvedValue(undefined);
  updateProfileMock.mockResolvedValue(undefined);
  googleSignInMock.mockResolvedValue({ user: { uid: "uid-google" } });
  // Default: a brand-new email whose OTP sends and verifies successfully.
  mockRequest({
    userStatus: STATUS_NEW_EMAIL,
    sendOtp: SEND_OTP_OK,
    verifyOtp: VERIFY_OTP_OK,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderRegister() {
  render(
    <RegisterView
      onBackToLogin={onBackToLogin}
      onExistingAccountLogin={onExistingAccountLogin}
      onGoogleOnlySetPassword={onGoogleOnlySetPassword}
    />
  );
}

describe("Registration page", () => {
  it("renders all fields and actions", () => {
    renderRegister();

    expect(
      screen.getByRole("heading", { name: "Create Account" })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter password")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Confirm password")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Account" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Google" })
    ).toBeInTheDocument();
    expect(screen.getByText("Already have an account?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    // OTP controls only appear once a code has been sent.
    expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
  });

  it("requires a username", async () => {
    renderRegister();
    fillForm({ username: "   " });
    submitForm();
    expect(
      await screen.findByText("Username is required.")
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid email", async () => {
    renderRegister();
    fillForm({ email: "not-an-email" });
    submitForm();
    expect(await screen.findByText("Enter a valid email.")).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("requires a password", async () => {
    renderRegister();
    fillForm({ password: "", confirm: "" });
    submitForm();
    expect(await screen.findByText("Password is required.")).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a short password", async () => {
    renderRegister();
    fillForm({ password: "123", confirm: "123" });
    submitForm();
    expect(
      await screen.findByText("Password must be at least 6 characters long.")
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords", async () => {
    renderRegister();
    fillForm({ password: "password1", confirm: "password2" });
    submitForm();
    expect(
      await screen.findByText("Passwords do not match.")
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("CASE 1: sends an OTP for a new email - no Firebase account is created before verification", async () => {
    renderRegister();
    fillForm();
    submitForm();

    // The backend account check runs BEFORE anything is sent.
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/user-status",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: EMAIL }),
        })
      );
    });

    // The OTP send uses the existing server-side OTP endpoint (default
    // link_password purpose) - no account is created yet.
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/otp/send",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: EMAIL }),
        })
      );
    });
    expect(createAccountMock).not.toHaveBeenCalled();

    expect(
      screen.getByText(`We sent a 6-digit verification code to ${EMAIL}.`)
    ).toBeInTheDocument();
    // OTP UI is now shown, the submit action becomes "Verify OTP".
    expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Verify OTP" })
    ).toBeInTheDocument();
  });

  it("CASE 1: creates the Firebase account only after the OTP is verified", async () => {
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/otp/send",
        expect.objectContaining({ method: "POST" })
      );
    });

    enterOtp("654321");
    submitOtp();

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/auth/otp/verify",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: EMAIL, otp: "654321" }),
        })
      );
    });

    await waitFor(() => {
      expect(createAccountMock).toHaveBeenCalledWith(
        auth,
        EMAIL,
        "password1"
      );
    });
    await waitFor(() => {
      expect(updateProfileMock).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "uid-new", email: EMAIL }),
        { displayName: "alice" }
      );
    });
    await waitFor(() => {
      expect(sendVerificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "uid-new" })
      );
    });
    expect(
      screen.getByText(`Account created! We sent a verification email to ${EMAIL}.`)
    ).toBeInTheDocument();
  });

  it("keeps the form fields visible above the OTP input but locked", async () => {
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    // Fields stay visible above the OTP input.
    expect(screen.getByPlaceholderText("Enter username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter password")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Confirm password")
    ).toBeInTheDocument();
    // ...but are locked so the verified values cannot drift.
    expect(screen.getByPlaceholderText("Enter username")).toBeDisabled();
    expect(screen.getByPlaceholderText("Enter email")).toBeDisabled();
    expect(screen.getByPlaceholderText("Enter password")).toBeDisabled();
    expect(screen.getByPlaceholderText("Confirm password")).toBeDisabled();
  });

  it("does not create an account when the OTP is rejected", async () => {
    mockRequest({
      userStatus: STATUS_NEW_EMAIL,
      sendOtp: SEND_OTP_OK,
      verifyOtp: new ApiError(400, "Invalid verification code. 2 attempt(s) remaining."),
    });
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    enterOtp("000000");
    submitOtp();

    expect(
      await screen.findByText(
        "Invalid verification code. 2 attempt(s) remaining."
      )
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("does not create an account when the OTP verify request fails", async () => {
    mockRequest({
      userStatus: STATUS_NEW_EMAIL,
      sendOtp: SEND_OTP_OK,
      verifyOtp: new ApiError(0, "Network error. Check your connection."),
    });
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    enterOtp("123456");
    submitOtp();

    expect(
      await screen.findByText("Network error. Check your connection.")
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("requires a full 6-digit code before verifying", async () => {
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    const verifyButton = screen.getByRole("button", {
      name: "Verify OTP",
    }) as HTMLButtonElement;
    expect(verifyButton.disabled).toBe(true);

    enterOtp("123");
    expect(verifyButton.disabled).toBe(true);

    enterOtp("123456");
    expect(verifyButton.disabled).toBe(false);
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("does not send a new code while the resend cooldown is active", async () => {
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    // Exactly one code has been sent so far.
    expect(countSendOtpCalls()).toBe(1);

    const resendButton = screen.getByRole("button", { name: /Resend code in/ });
    expect(resendButton).toBeDisabled();

    fireEvent.click(resendButton);
    expect(countSendOtpCalls()).toBe(1);
  });

  it("resends a code once the cooldown has expired", async () => {
    // Use a short cooldown so the resend button re-enables within the test.
    mockRequest({
      userStatus: STATUS_NEW_EMAIL,
      sendOtp: { message: "sent", cooldown_seconds: 1 },
      verifyOtp: VERIFY_OTP_OK,
    });
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    const resendButton = await screen.findByRole(
      "button",
      { name: "Resend OTP" },
      { timeout: 3000 }
    );
    fireEvent.click(resendButton);

    await waitFor(() => {
      expect(countSendOtpCalls()).toBe(2);
    });
  });

  it("shows a safe error when the OTP email cannot be sent", async () => {
    mockRequest({
      userStatus: STATUS_NEW_EMAIL,
      sendOtp: new ApiError(502, "We couldn't send the verification email. Please try again."),
    });
    renderRegister();
    fillForm();
    submitForm();

    expect(
      await screen.findByText(
        "We couldn't send the verification email. Please try again."
      )
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
  });

  it("can go back to login from the OTP stage", async () => {
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to Login" }));
    expect(onBackToLogin).toHaveBeenCalled();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("CASE 2: existing email/password account is detected - no OTP, no account, Login shown", async () => {
    mockRequest({ userStatus: STATUS_PASSWORD });
    renderRegister();
    fillForm();
    submitForm();

    expect(
      await screen.findByText(
        "An account with this email already exists. Please log in."
      )
    ).toBeInTheDocument();
    // No account, no OTP, and no duplicate UID are ever created.
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(countSendOtpCalls()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(onExistingAccountLogin).toHaveBeenCalledWith(EMAIL);
  });

  it("CASE 3: existing Google-only account is detected - Google + Set Password shown", async () => {
    mockRequest({ userStatus: STATUS_GOOGLE_ONLY });
    renderRegister();
    fillForm();
    submitForm();

    expect(
      await screen.findByText(
        "An account with this email already exists with Google."
      )
    ).toBeInTheDocument();
    // No account and no duplicate UID are ever created.
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(countSendOtpCalls()).toBe(0);

    // The existing Google OAuth sign-in is available.
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => {
      expect(googleSignInMock).toHaveBeenCalledWith(auth, googleProvider);
    });

    // The existing Google-only -> OTP -> Set Password flow is available.
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
    expect(onGoogleOnlySetPassword).toHaveBeenCalledWith(EMAIL);
  });

  it("CASE 4: existing Google + password account is detected - no new account, Login shown", async () => {
    mockRequest({ userStatus: STATUS_GOOGLE_PASSWORD });
    renderRegister();
    fillForm();
    submitForm();

    expect(
      await screen.findByText(
        "An account with this email already exists. Please log in."
      )
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(countSendOtpCalls()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(onExistingAccountLogin).toHaveBeenCalledWith(EMAIL);
  });

  it("safely handles a duplicate-email race condition at creation time", async () => {
    // The check reports a new email and the OTP verifies, but the account is
    // created before our own creation call lands - Firebase's error is mapped
    // to a safe message.
    createAccountMock.mockRejectedValue({ code: "auth/email-already-in-use" });
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    enterOtp("123456");
    submitOtp();

    expect(
      await screen.findByText(
        "This email is already registered. Please log in instead."
      )
    ).toBeInTheDocument();
    // The raw Firebase message is never shown.
    expect(
      screen.queryByText("EMAIL_EXISTS", { exact: false })
    ).not.toBeInTheDocument();
  });

  it("does not create an account when the server-side check fails", async () => {
    requestMock.mockRejectedValue(new ApiError(0, "Network error. Check your connection."));
    renderRegister();
    fillForm();
    submitForm();

    expect(
      await screen.findByText("Network error. Check your connection.")
    ).toBeInTheDocument();
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("123456")).not.toBeInTheDocument();
  });

  it("never shows raw Firebase errors to the user", async () => {
    createAccountMock.mockRejectedValue({
      code: "auth/internal-error",
      message: "INTERNAL: internal error details",
    });
    renderRegister();
    fillForm();
    submitForm();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("123456")).toBeInTheDocument();
    });

    enterOtp("123456");
    submitOtp();

    expect(
      await screen.findByText(
        "Failed to create your account. Please try again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("INTERNAL")).not.toBeInTheDocument();
  });

  it("uses the existing Google OAuth sign-in", async () => {
    renderRegister();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => {
      expect(googleSignInMock).toHaveBeenCalledWith(auth, googleProvider);
    });
  });

  it("links back to the login page", () => {
    renderRegister();
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(onBackToLogin).toHaveBeenCalled();
  });
});
