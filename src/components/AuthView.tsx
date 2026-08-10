"use client";

import { useEffect, useState } from "react";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import {
  isCompleteOtp,
  shouldShowSetPassword,
  UserStatus,
  validateNewPassword
} from "@/lib/authFlow";
import { request, ApiError } from "@/services/api";
import Spinner from "./Spinner";
import RegisterView from "./RegisterView";

type AuthStep =
  | "LOGIN"
  | "REGISTER"
  | "CONFLICT_NOTICE"
  | "OTP_VERIFY"
  | "SET_PASSWORD"
  | "SUCCESS"
  | "FORGOT_EMAIL"
  | "FORGOT_OTP"
  | "FORGOT_NEW_PASSWORD";

interface SendOtpResponse {
  message: string;
  cooldown_seconds: number;
}

interface VerifyOtpResponse {
  verified: boolean;
  verification_token: string;
}

interface AuthViewProps {
  onBack?: () => void;
}

export default function AuthView({ onBack }: AuthViewProps = {}) {
  const [step, setStep] = useState<AuthStep>("LOGIN");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [verificationToken, setVerificationToken] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Count down the OTP resend cooldown so the resend button re-enables.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // ---------------------------------------------------- FLOW A: GOOGLE LOGIN
  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error("Google Sign-In Error:", err);
      if (err?.code === "auth/unauthorized-domain" || err?.message?.includes("unauthorized-domain")) {
        setError("Domain authorization error: This domain/IP is not listed under Firebase Console -> Authentication -> Settings -> Authorized Domains. Please use Email/Password login or access via http://localhost:3000.");
      } else {
        setError(err.message || "Failed to sign in with Google.");
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- FLOW C: EMAIL LOGIN & CONFLICT CHECK
  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (firebaseErr: any) {
      console.log("Firebase Auth Error Code:", firebaseErr.code);

      // Check if this account exists in Firebase via our backend helper
      try {
        const status = await request<UserStatus>("/auth/user-status", {
          method: "POST",
          body: JSON.stringify({ email }),
        });

        if (shouldShowSetPassword(status)) {
          // Account exists via Google provider but no password set yet
          setStep("CONFLICT_NOTICE");
          setLoading(false);
          return;
        }
      } catch {
        // Fallback to default message
      }

      if (
        firebaseErr.code === "auth/invalid-credential" ||
        firebaseErr.code === "auth/wrong-password" ||
        firebaseErr.code === "auth/user-not-found"
      ) {
        setError("Invalid email or password. If you registered via Google, click Continue with Google.");
      } else {
        setError(firebaseErr.message || "Authentication failed. Please check your credentials.");
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- FLOW D: START OTP VERIFICATION
  const startOtpFlow = async () => {
    setError(null);
    setInfoMessage(null);
    setLoading(true);

    try {
      const res = await request<SendOtpResponse>("/auth/otp/send", {
        method: "POST",
        body: JSON.stringify({ email }),
      });

      setInfoMessage(`Verification code sent to ${email}`);
      setCooldown(res.cooldown_seconds || 60);
      setStep("OTP_VERIFY");
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to send verification code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  // VERIFY OTP CODE
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCompleteOtp(otpCode)) {
      setError("Please enter a valid 6-digit code.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await request<VerifyOtpResponse>("/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ email, otp: otpCode }),
      });

      if (res.verified && res.verification_token) {
        setVerificationToken(res.verification_token);
        setStep(step === "FORGOT_OTP" ? "FORGOT_NEW_PASSWORD" : "SET_PASSWORD");
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to verify code. Please check and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- FLOW E: SET PASSWORD & LINK CREDENTIAL
  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    const pwError = validateNewPassword(password, confirmPassword);
    if (pwError) {
      setError(pwError);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await request<{ success: boolean; message: string }>("/auth/set-password", {
        method: "POST",
        body: JSON.stringify({
          email,
          verification_token: verificationToken,
          password,
        }),
      });

      setInfoMessage("Password set successfully! Logging you in...");
      // Immediately log in with new password
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to set password. Please try again.");
      }
      setLoading(false);
    }
  };

  // ---------------------------------------------------- FLOW F: FORGOT PASSWORD
  const goBackToLogin = () => {
    setStep("LOGIN");
    setError(null);
    setInfoMessage(null);
    setOtpCode("");
    setPassword("");
    setConfirmPassword("");
    setVerificationToken("");
    setCooldown(0);
  };

  const handleForgotPasswordClick = () => {
    setError(null);
    setInfoMessage(null);
    setStep("FORGOT_EMAIL");
  };

  // New users can open the registration page from the login screen. Existing
  // users are never forced into it, and returning to login is always available.
  const handleCreateAccountClick = () => {
    setError(null);
    setInfoMessage(null);
    setEmail("");
    setPassword("");
    setStep("REGISTER");
  };

  // Existing email/password (or Google + password) account detected during
  // registration: send the user to login with the email pre-filled.
  const handleExistingAccountLogin = (existingEmail: string) => {
    setEmail(existingEmail);
    setError(null);
    setInfoMessage(null);
    setStep("LOGIN");
  };

  // Google-only account detected during registration: hand off to the existing
  // Google-only -> OTP -> Set Password flow (same UID, no duplicate account).
  const handleGoogleOnlySetPassword = (existingEmail: string) => {
    setEmail(existingEmail);
    setError(null);
    setInfoMessage(null);
    setStep("CONFLICT_NOTICE");
  };

  const sendForgotOtp = async () => {
    if (!email) {
      setError("Please enter your email address.");
      return;
    }

    setError(null);
    setInfoMessage(null);
    setLoading(true);

    try {
      // A Google-only account has no password to reset: direct it to the
      // existing Set Password flow, which links a password to the SAME UID and
      // never creates a duplicate account. The backend also re-checks the
      // account (and its password provider) before mailing any OTP, so a reset
      // code can never go to an address with no account.
      try {
        const status = await request<UserStatus>("/auth/user-status", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        if (!status.exists) {
          setError("No account found with this email address.");
          return;
        }
        if (shouldShowSetPassword(status)) {
          setStep("CONFLICT_NOTICE");
          return;
        }
      } catch {
        // Ignore status lookup failures; the backend re-checks authoritatively.
      }

      const res = await request<SendOtpResponse>("/auth/otp/send", {
        method: "POST",
        body: JSON.stringify({ email, purpose: "reset_password" }),
      });

      setInfoMessage(`Verification code sent to ${email}`);
      setCooldown(res.cooldown_seconds || 60);
      setStep("FORGOT_OTP");
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to send verification code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    const pwError = validateNewPassword(password, confirmPassword);
    if (pwError) {
      setError(pwError);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await request<{ success: boolean; message: string }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({
          email,
          verification_token: verificationToken,
          password,
        }),
      });

      setInfoMessage("Password reset successfully! Logging you in...");
      // Immediately log in with the new password.
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to reset password. Please try again.");
      }
      setLoading(false);
    }
  };

  // Registration is a standalone page. It renders its own header and card so
  // the login/OTP state machine is not duplicated inside it.
  if (step === "REGISTER") {
    return (
      <RegisterView
        onBackToLogin={goBackToLogin}
        onExistingAccountLogin={handleExistingAccountLogin}
        onGoogleOnlySetPassword={handleGoogleOnlySetPassword}
      />
    );
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#050505] p-4 font-sans text-neutral-100">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-neutral-800/80 bg-[#0A0A0A] p-8 shadow-2xl backdrop-blur-md relative">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-2 inline-flex items-center text-xs font-mono text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            ← Back to Landing Page
          </button>
        )}
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
            {step === "LOGIN" && "Sign in to NEXUSS"}
            {step === "CONFLICT_NOTICE" && "Account Linking Required"}
            {step === "OTP_VERIFY" && "Verify Email Address"}
            {step === "SET_PASSWORD" && "Create Password"}
            {step === "FORGOT_EMAIL" && "Forgot Password"}
            {step === "FORGOT_OTP" && "Verify Email Address"}
            {step === "FORGOT_NEW_PASSWORD" && "Reset Password"}
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            {step === "LOGIN" && "Access your AI providers and local conversation data"}
            {step === "CONFLICT_NOTICE" && "Link password credentials to your existing account"}
            {step === "OTP_VERIFY" && `We sent a 6-digit code to ${email}`}
            {step === "SET_PASSWORD" && "Set a password to log in with Email or Google"}
            {step === "FORGOT_EMAIL" && "We'll email you a verification code"}
            {step === "FORGOT_OTP" && `We sent a 6-digit code to ${email}`}
            {step === "FORGOT_NEW_PASSWORD" && "Choose a new password for your account"}
          </p>
        </div>

        {/* Global Error Banner */}
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

        {/* STEP 1: LOGIN FORM */}
        {step === "LOGIN" && (
          <div className="space-y-6">
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

            <div className="relative flex items-center justify-center">
              <div className="w-full border-t border-gray-800"></div>
              <span className="absolute bg-gray-900 px-3 text-xs uppercase text-gray-500">
                Or with Email
              </span>
            </div>

            <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                {loading ? <Spinner className="h-5 w-5" /> : "Sign In"}
              </button>

              <button
                type="button"
                onClick={handleForgotPasswordClick}
                className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
              >
                Forgot Password?
              </button>
            </form>

            <div className="border-t border-gray-800 pt-4 text-center text-xs text-gray-500">
              New here?{" "}
              <button
                type="button"
                onClick={handleCreateAccountClick}
                className="font-semibold text-blue-500 hover:text-blue-400"
              >
                Create an account
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: FLOW C RECOVERY / LINKING CONFLICT NOTICE */}
        {step === "CONFLICT_NOTICE" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-amber-800/40 bg-amber-950/30 p-4 text-sm text-amber-200">
              <p className="font-semibold text-amber-100">Account Found!</p>
              <p className="mt-1 text-xs text-amber-300/80">
                Your account (<span className="font-mono text-white">{email}</span>) exists, but you haven&apos;t set an email password yet. You currently sign in with Google.
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleGoogleSignIn}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Continue with Google
              </button>

              <button
                onClick={startOtpFlow}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-800/80 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700"
              >
                {loading ? <Spinner className="h-5 w-5" /> : "Verify Email & Set Password"}
              </button>

              <button
                onClick={() => {
                  setStep("LOGIN");
                  setError(null);
                }}
                className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
              >
                Back to Login
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: FLOW D OTP VERIFICATION */}
        {step === "OTP_VERIFY" && (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400">Enter 6-Digit Code</label>
              <input
                type="text"
                required
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="mt-2 block w-full tracking-widest text-center text-2xl font-mono rounded-xl border border-gray-800 bg-gray-950 py-3 text-white placeholder-gray-700 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.length !== 6}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? <Spinner className="h-5 w-5" /> : "Verify Code"}
            </button>

            <div className="flex items-center justify-between text-xs text-gray-500">
              <button
                type="button"
                onClick={startOtpFlow}
                disabled={cooldown > 0 || loading}
                className="hover:text-gray-300 disabled:opacity-50"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend Code"}
              </button>

              <button
                type="button"
                onClick={() => setStep("LOGIN")}
                className="hover:text-gray-300"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* STEP 4: FLOW E SET PASSWORD */}
        {step === "SET_PASSWORD" && (
          <form onSubmit={handleSetPassword} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400">New Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400">Confirm Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? <Spinner className="h-5 w-5" /> : "Set Password & Link Account"}
            </button>
          </form>
        )}

        {/* STEP 5: FLOW F FORGOT PASSWORD - EMAIL */}
        {step === "FORGOT_EMAIL" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendForgotOtp();
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-gray-400">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? <Spinner className="h-5 w-5" /> : "Send OTP"}
            </button>

            <button
              type="button"
              onClick={goBackToLogin}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
            >
              Back to Login
            </button>
          </form>
        )}

        {/* STEP 6: FLOW F FORGOT PASSWORD - OTP */}
        {step === "FORGOT_OTP" && (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400">Enter 6-Digit Code</label>
              <input
                type="text"
                required
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="mt-2 block w-full tracking-widest text-center text-2xl font-mono rounded-xl border border-gray-800 bg-gray-950 py-3 text-white placeholder-gray-700 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.length !== 6}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? <Spinner className="h-5 w-5" /> : "Verify OTP"}
            </button>

            <div className="flex items-center justify-between text-xs text-gray-500">
              <button
                type="button"
                onClick={sendForgotOtp}
                disabled={cooldown > 0 || loading}
                className="hover:text-gray-300 disabled:opacity-50"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend OTP"}
              </button>

              <button type="button" onClick={goBackToLogin} className="hover:text-gray-300">
                Back to Login
              </button>
            </div>
          </form>
        )}

        {/* STEP 7: FLOW F FORGOT PASSWORD - NEW PASSWORD */}
        {step === "FORGOT_NEW_PASSWORD" && (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400">New Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400">Confirm Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="mt-1 block w-full rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? <Spinner className="h-5 w-5" /> : "Reset Password"}
            </button>

            <button
              type="button"
              onClick={goBackToLogin}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
            >
              Back to Login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
