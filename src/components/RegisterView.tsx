"use client";

import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithPopup,
  updateProfile,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import {
  getRegistrationErrorMessage,
  isCompleteOtp,
  UserStatus,
  validateRegistration,
} from "@/lib/authFlow";
import { request, ApiError } from "@/services/api";
import Spinner from "./Spinner";

type DuplicateNotice = "password_exists" | "google_exists" | null;

interface SendOtpResponse {
  message: string;
  cooldown_seconds: number;
}

interface VerifyOtpResponse {
  verified: boolean;
  verification_token: string;
}

export default function RegisterView({
  onBackToLogin,
  onExistingAccountLogin,
  onGoogleOnlySetPassword,
}: {
  onBackToLogin: () => void;
  onExistingAccountLogin: (email: string) => void;
  onGoogleOnlySetPassword: (email: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<DuplicateNotice>(null);

  // OTP verification stage. A NEW email must first prove ownership through the
  // existing server-side OTP system before any Firebase account is created.
  const [otpStage, setOtpStage] = useState(false);
  const [otp, setOtp] = useState("");
  const [cooldown, setCooldown] = useState(0);

  // Count down the OTP resend cooldown so the resend button re-enables.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Google OAuth reuses the EXACT existing Google sign-in (same provider,
  // same handler shape as the login page). No Google auth logic is modified.
  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error("Google Sign-In Error:", err);
      setError(err.message || "Failed to sign in with Google.");
    } finally {
      setLoading(false);
    }
  };

  // Email/password registration uses the existing Firebase auth flow:
  // createUserWithEmailAndPassword (same Firebase UID behavior as login), the
  // display name is stored via Firebase updateProfile, and the verification
  // email is sent via the existing sendEmailVerification mechanism.
  //
  // BEFORE creating anything, the backend securely resolves the email address
  // with the Firebase Admin SDK (account existence and providers are never
  // trusted from the client). If the account already exists we never create a
  // second account or UID, and the duplicate-email race is still covered by
  // Firebase's own auth/email-already-in-use error on the final creation call.
  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setNotice(null);

    const validationError = validateRegistration(
      username,
      email,
      password,
      confirmPassword
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      // Server-side account check BEFORE creating anything.
      let status: UserStatus;
      try {
        status = await request<UserStatus>("/auth/user-status", {
          method: "POST",
          body: JSON.stringify({ email: email.trim() }),
        });
      } catch {
        // Never create an account when the server-side check could not be
        // completed. Surface a safe error instead.
        setError("Network error. Check your connection.");
        return;
      }

      if (status.exists) {
        // CASE 2 & 4: account already has a password -> no new account, Login.
        // CASE 3: Google-only account -> no new account, Google + Set Password.
        setNotice(status.has_password ? "password_exists" : "google_exists");
        return;
      }

      // CASE 1: NEW email. No account is created yet. The user must first
      // prove ownership of the address through the existing server-side OTP
      // system (single-use 6-digit code, hashed in the DB, delivered by email).
      // Firebase creation is only reached AFTER the code is verified.
      const res = await request<SendOtpResponse>("/auth/otp/send", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });

      setOtp("");
      setOtpStage(true);
      setCooldown(res.cooldown_seconds || 60);
      setInfoMessage(
        `We sent a 6-digit verification code to ${email.trim()}.`
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(getRegistrationErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  // Verify the emailed code, and only then create the Firebase account.
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCompleteOtp(otp)) {
      setError("Please enter a valid 6-digit code.");
      return;
    }

    setError(null);
    setInfoMessage(null);
    setLoading(true);

    try {
      const res = await request<VerifyOtpResponse>("/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), otp }),
      });

      if (!res.verified) {
        setError("Invalid or expired verification code.");
        return;
      }

      // OTP confirmed server-side. NOW create the Firebase account. The
      // verification_token returned here is for password-linking only and is
      // intentionally ignored by the registration flow.
      const credential = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );
      try {
        await updateProfile(credential.user, { displayName: username.trim() });
      } catch {
        // Non-fatal: the account is created either way.
      }
      try {
        await sendEmailVerification(credential.user);
        setInfoMessage(
          `Account created! We sent a verification email to ${email.trim()}.`
        );
      } catch {
        setInfoMessage("Account created successfully.");
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        // Duplicate-email race between OTP send and creation.
        setError(getRegistrationErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  // Resend a fresh code (subject to the same 60s server cooldown).
  const handleResendOtp = async () => {
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await request<SendOtpResponse>("/auth/otp/send", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setOtp("");
      setCooldown(res.cooldown_seconds || 60);
      setInfoMessage(
        `We sent a new verification code to ${email.trim()}.`
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to send verification code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Leave the OTP stage and return to the login page.
  const exitOtpStage = () => {
    setOtpStage(false);
    setOtp("");
    setCooldown(0);
    setError(null);
    setInfoMessage(null);
    onBackToLogin();
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#050505] p-4 font-sans text-neutral-100">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-neutral-800/80 bg-[#0A0A0A] p-8 shadow-2xl backdrop-blur-md">
        {/* Header */}
        <div className="text-center flex flex-col items-center">
          <div className="relative mb-3 w-9 h-9 flex items-center justify-center shrink-0">
            <img
              src="/nexuss-logo.png"
              alt="NEXUSS Logo"
              className="w-full h-full object-contain"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Create Account
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            Set up your account to start chatting
          </p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="rounded-xl border border-red-800/50 bg-red-950/50 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Info Banner */}
        {infoMessage && (
          <div className="rounded-xl border border-blue-800/50 bg-blue-950/50 p-4 text-sm text-blue-300">
            {infoMessage}
          </div>
        )}

        {/* Registration form (hidden while a duplicate-account notice is shown) */}
        {notice === null && (
          <form
            onSubmit={otpStage ? handleVerifyOtp : handleCreateAccount}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-gray-400">
                Username
              </label>
              <input
                type="text"
                required
                value={username}
                disabled={otpStage}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                disabled={otpStage}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter email"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                disabled={otpStage}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400">
                Confirm Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                disabled={otpStage}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>

            {/* OTP verification stage: shown below the form fields, above the
                submit button. The fields above stay visible but are locked so
                the verified email/password cannot drift after the code is sent. */}
            {otpStage && (
              <div>
                <label className="block text-xs font-medium text-gray-400">
                  Enter 6-Digit Code
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className="mt-2 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-center font-mono text-2xl tracking-widest text-white placeholder-gray-700 focus:border-blue-500 focus:outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (otpStage && otp.length !== 6)}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? (
                <Spinner className="h-5 w-5" />
              ) : otpStage ? (
                "Verify OTP"
              ) : (
                "Create Account"
              )}
            </button>

            {otpStage && (
              <div className="flex items-center justify-between text-xs text-gray-500">
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={cooldown > 0 || loading}
                  className="hover:text-gray-300 disabled:opacity-50"
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend OTP"}
                </button>

                <button
                  type="button"
                  onClick={exitOtpStage}
                  disabled={loading}
                  className="hover:text-gray-300 disabled:opacity-50"
                >
                  Back to Login
                </button>
              </div>
            )}
          </form>
        )}

        {/* CASE 2 & 4: existing email/password account -> Login */}
        {notice === "password_exists" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-800/40 bg-amber-950/30 p-4 text-sm text-amber-200">
              <p className="font-semibold text-amber-100">
                An account with this email already exists. Please log in.
              </p>
              <p className="mt-1 text-xs text-amber-300/80">
                Your email and password are already registered.
              </p>
            </div>

            <button
              type="button"
              onClick={() => onExistingAccountLogin(email.trim())}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Login
            </button>

            <button
              type="button"
              onClick={() => setNotice(null)}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
            >
              Use a different email
            </button>
          </div>
        )}

        {/* CASE 3: existing Google-only account -> Google + Set Password */}
        {notice === "google_exists" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-800/40 bg-amber-950/30 p-4 text-sm text-amber-200">
              <p className="font-semibold text-amber-100">
                An account with this email already exists with Google.
              </p>
              <p className="mt-1 text-xs text-amber-300/80">
                Sign in with Google, or set an email password on your existing
                account.
              </p>
            </div>

            <button
              type="button"
              onClick={handleGoogleSignIn}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Continue with Google
            </button>

            <button
              type="button"
              onClick={() => onGoogleOnlySetPassword(email.trim())}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-800/80 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700"
            >
              Set Password
            </button>

            <button
              type="button"
              onClick={() => setNotice(null)}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
            >
              Use a different email
            </button>
          </div>
        )}

        {/* Divider + Google OAuth - identical to the existing Google sign-in.
            Hidden while a duplicate-account notice is shown. */}
        {notice === null && (
          <>
            <div className="relative flex items-center justify-center">
              <div className="w-full border-t border-gray-800"></div>
              <span className="absolute bg-gray-900 px-3 text-xs uppercase text-gray-500">
                OR
              </span>
            </div>

            <button
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="flex w-full items-center justify-center gap-3 rounded-xl border border-gray-700 bg-gray-800/80 px-4 py-3 text-sm font-semibold text-white transition duration-200 hover:bg-gray-700 disabled:opacity-50"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              Continue with Google
            </button>
          </>
        )}

        {/* Back to login (only on the fresh form, not while a notice is shown) */}
        {notice === null && (
          <div className="pt-2 text-center text-sm text-gray-400">
            Already have an account?{" "}
            <button
              type="button"
              onClick={onBackToLogin}
              className="font-semibold text-blue-500 hover:text-blue-400"
            >
              Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
