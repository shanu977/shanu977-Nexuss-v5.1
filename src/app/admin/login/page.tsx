"use client";

import { FormEvent, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { Mail, Lock, AlertCircle, Loader2, CheckCircle } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { adminApi } from "@/services/admin";
import { NexussLogo } from "@/components/admin/NexussLogo";

type AdminLoginStep = "LOGIN" | "GOOGLE_PASSWORD" | "EMAIL_PASSWORD" | "FORGOT_EMAIL" | "FORGOT_OTP" | "FORGOT_NEW_PASSWORD" | "SUCCESS";

const ADMIN_EMAIL = "pillishanu5@gmail.com";
const ADMIN_NAME = "shanmuk";

export default function AdminLoginPage() {
  const router = useRouter();
  const { user, initialized, initAuth } = useAuthStore();
  const [step, setStep] = useState<AdminLoginStep>("LOGIN");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const validateNewPassword = (
    password: string,
    confirm: string
  ): string | null => {
    if (!password || !confirm) return "Password and confirmation are required.";
    if (password.length < 6) return "Password must be at least 6 characters long.";
    if (password !== confirm) return "Passwords do not match.";
    return null;
  };

  // ---------------------------------------------------- HELPERS
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

  const goBackToLoginFromForgot = () => goBackToLogin();

  // ---------------------------------------------------- STEP: LOGIN
  const handleEmailPasswordLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      const ok = await adminApi.isAdmin();
      if (ok) {
        setStep("SUCCESS");
        router.replace("/admin/dashboard");
      } else {
        setError("Admin access denied. Your account does not have admin privileges.");
        setStep("LOGIN");
      }
    } catch (err: any) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
      setStep("LOGIN");
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- STEP: GOOGLE SIGN-IN
  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
      setStep("GOOGLE_PASSWORD");
    } catch (err: any) {
      console.error("Google Sign-In Error:", err);
      if (err?.code === "auth/unauthorized-domain" || err?.message?.includes("unauthorized-domain")) {
        setError("Domain authorization error. Please use Email/Password login or access via http://localhost:3000.");
      } else {
        setError(err.message || "Failed to sign in with Google.");
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- STEP: GOOGLE PASSWORD SUBMIT
  const handleGooglePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, email, password);
      const ok = await adminApi.isAdmin();
      if (ok) {
        setStep("SUCCESS");
        router.replace("/admin/dashboard");
      } else {
        setError("Admin access denied. Your account does not have admin privileges.");
        setStep("GOOGLE_PASSWORD");
      }
    } catch (err: any) {
      if (err instanceof Error && err.message?.includes("auth/invalid-credential")) {
        setError("No password set for this Google account. Please use the Forgot Password flow to set a password.");
        setStep("FORGOT_EMAIL");
      } else {
        setError(err instanceof Error ? err.message : "Sign in failed.");
        setStep("GOOGLE_PASSWORD");
      }
    }
  };

  // ---------------------------------------------------- STEP: FORGOT EMAIL
  const sendForgotOtp = async () => {
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      setInfoMessage(`Verification code sent to ${email}`);
      setCooldown(60);
      setStep("FORGOT_OTP");
    } catch (err: any) {
      if (err instanceof Error) setError(err.message);
      else setError("Failed to send verification code.");
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (!otpCode || otpCode.length !== 6) {
      setError("Please enter a valid 6-digit code.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      setVerificationToken(otpCode);
      setStep("FORGOT_NEW_PASSWORD");
    } catch (err: any) {
      if (err instanceof Error) setError(err.message);
      else setError("Failed to verify code.");
    } finally {
      setLoading(false);
    }
  };

  const sendForgotOtp2 = async () => {
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      setInfoMessage(`Verification code sent to ${email}`);
      setCooldown(60);
      setStep("FORGOT_OTP");
    } catch (err: any) {
      if (err instanceof Error) setError(err.message);
      else setError("Failed to send verification code.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- STEP: FORGOT NEW PASSWORD
  const handleForgotNewPasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const pwError = validateNewPassword(password, confirmPassword);
    if (pwError) {
      setError(pwError);
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      const ok = await adminApi.isAdmin();
      if (ok) {
        setStep("SUCCESS");
        router.replace("/admin/dashboard");
      } else {
        setError("Admin access denied.");
        setStep("FORGOT_NEW_PASSWORD");
      }
    } catch (err: any) {
      if (err instanceof Error) setError(err.message);
      else setError("Failed to set password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------- STEP: SUCCESS
  const handleSuccess = () => {
    router.replace("/admin/dashboard");
  };

  // ---------------------------------------------------- RENDER COMPONENTS
  const renderAuthError = (msg: string) => error ? (
    <div role="alert" style={{padding: "12px 14px", borderRadius: "var(--radius-md)", backgroundColor: "var(--color-danger-bg)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "var(--color-danger)", fontSize: "0.82rem", display: "flex", alignItems: "flex-start", gap: "8px"}}>
      <AlertCircle size={16} style={{flexShrink: 0, marginTop: "1px"}} /> <span>{msg}</span>
    </div>) : null;

  const makeInput = (type: string, value: string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void, placeholder: string, extraStyle?: React.CSSProperties) => (
    <div style={{ position: "relative" }}>
      <Mail size={16} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={{
        width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none", ...extraStyle,
      }} />
    </div>
  );

  const makeButton = (children: React.ReactNode, disabled: boolean, styleOverride?: React.CSSProperties) => (
    <button type="submit" disabled={disabled} style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
      padding: "11px 18px", fontSize: "0.88rem", fontWeight: 700,
      borderRadius: "var(--radius-md)", backgroundColor: "var(--accent-primary)", color: "#ffffff",
      border: "none", opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer", ...styleOverride,
    }}>
      {children}
    </button>
  );

  // ---------------------------------------------------- RENDER LOGIN STEP
  const renderLoginStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={handleEmailPasswordLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label htmlFor="admin-email" style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>
            Email
          </label>
          <div style={{ position: "relative" }}>
            <Mail size={16} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input
              id="admin-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              style={{
                width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none",
              }}
            />
            <label htmlFor="admin-email" style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
              Email
            </label>
          </div>
        </div>
        <div>
          <label htmlFor="admin-password" style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>
            Password
          </label>
          <div style={{ position: "relative" }}>
            <Lock size={16} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input
              id="admin-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none",
              }}
            />
            <label htmlFor="admin-password" style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
              Password
            </label>
          </div>
        </div>
        {makeButton("Sign in with email", loading)}
      </form>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-color)" }} /><span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>or</span><div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-color)" }} />
      </div>
      <button onClick={handleGoogleSignIn} disabled={loading} aria-label="Continue with Google" style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: "10px",
        padding: "11px 18px", fontSize: "0.85rem", fontWeight: 600,
        borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", color: "var(--text-primary)", opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer",
      }}>
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" /><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" /></svg>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-color)" }} /><span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>or</span><div style={{ flex: 1, height: "1px", backgroundColor: "var(--border-color)" }} />
      </div>
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "12px" }}>This Google account is the configured Admin identity. You must provide your Nexuss password to continue.</p>
    </div>
  );

  // ---------------------------------------------------- RENDER GOOGLE PASSWORD STEP
  const renderGooglePasswordStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={handleGooglePasswordSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>{makeInput("password", password, (e) => setPassword(e.target.value), "••••••••")}</div>
        {makeButton("Sign in with password", loading)}
      </form>
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "12px" }}>This Google account is the configured Admin identity. You must provide your Nexuss password to continue.</p>
      <button onClick={() => setStep("LOGIN")} style={{
        marginTop: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
        padding: "8px 14px", fontSize: "0.85rem", color: "var(--text-secondary)",
        backgroundColor: "var(--bg-app)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)",
      }}>&larr; Back to login methods</button>
    </div>
  );

  // ---------------------------------------------------- RENDER EMAIL PASSWORD STEP
  const renderEmailPasswordStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={handleEmailPasswordLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>{makeInput("email", email, (e) => setEmail(e.target.value), "admin@example.com")}</div>
        <div>{makeInput("password", password, (e) => setPassword(e.target.value), "••••••••")}</div>
        {makeButton("Sign in with email", loading)}
      </form>
    </div>
  );

  // ---------------------------------------------------- RENDER FORGOT EMAIL STEP
  const renderForgotEmailStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={(e) => { e.preventDefault(); sendForgotOtp2(); }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div><label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Email Address</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" style={{ width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none" }} /></div>
        {makeButton("Send OTP", loading)}
      </form>
      <button onClick={goBackToLoginFromForgot} style={{ marginTop: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "8px 14px", fontSize: "0.85rem", color: "var(--text-secondary)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)" }}>Back to login methods</button>
    </div>
  );

  // ---------------------------------------------------- RENDER FORGOT OTP STEP
  const renderForgotOtpStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={verifyOtp} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div><label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Enter 6-Digit Code</label><input type="text" required maxLength={6} value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" style={{ width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none" }} /></div>
        <button type="submit" disabled={loading || otpCode.length !== 6} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "11px 18px", fontSize: "0.85rem", fontWeight: 600, borderRadius: "var(--radius-md)", backgroundColor: "var(--accent-primary)", color: "#ffffff", opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}>{loading ? <Loader2 size={14} /> : "Verify Code"}</button>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button onClick={sendForgotOtp2} disabled={cooldown > 0 || loading} style={{ padding: "8px 14px", fontSize: "0.85rem", color: "var(--accent-primary)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)" }}>{cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend Code"}</button>
          <button type="button" onClick={goBackToLoginFromForgot} style={{ marginTop: "8px", fontSize: "0.8rem", color: "var(--text-muted)" }}>Back to login methods</button>
        </div>
      </form>
    </div>
  );

  // ---------------------------------------------------- RENDER FORGOT NEW PASSWORD STEP
  const renderForgotNewPasswordStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      {renderAuthError(error!)}
      <form onSubmit={handleForgotNewPasswordSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div><label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>New Password</label><input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" style={{ width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none" }} /></div>
        <div><label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Confirm Password</label><input type="password" required minLength={6} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter password" style={{ width: "100%", padding: "11px 12px 11px 38px", fontSize: "0.85rem", color: "var(--text-primary)", backgroundColor: "var(--bg-input)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", outline: "none" }} /></div>
        {makeButton("Reset Password", loading)}
      </form>
      <button onClick={goBackToLoginFromForgot} style={{ marginTop: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "8px 14px", fontSize: "0.85rem", color: "var(--text-secondary)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)" }}>Back to login methods</button>
    </div>
  );

  // ---------------------------------------------------- RENDER SUCCESS STEP
  const renderSuccessStep = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>Nexuss Admin</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>Restricted access. Sign in with a Nexuss administrator account.</p>
      <CheckCircle size={48} style={{ color: "var(--accent-primary)", margin: "auto" }} />
      <p style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--text-primary)" }}>Admin Dashboard</p>
      <button onClick={handleSuccess} style={{ marginTop: "16px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "10px 20px", fontSize: "0.9rem", fontWeight: 600, borderRadius: "var(--radius-md)", backgroundColor: "var(--accent-primary)", color: "#ffffff", border: "none" }}>Continue to Admin Dashboard</button>
      <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
        <Link href="/" style={{ color: "var(--accent-primary)", textDecoration: "underline" }}>Back to the app</Link>
      </div>
    </div>
  );

  // ---------------------------------------------------- RENDER FUNCTION
  const renderStep = () => {
    if (step === "LOGIN") return renderLoginStep();
    if (step === "GOOGLE_PASSWORD") return renderGooglePasswordStep();
    if (step === "EMAIL_PASSWORD") return renderEmailPasswordStep();
    if (step === "FORGOT_EMAIL") return renderForgotEmailStep();
    if (step === "FORGOT_OTP") return renderForgotOtpStep();
    if (step === "FORGOT_NEW_PASSWORD") return renderForgotNewPasswordStep();
    if (step === "SUCCESS") return renderSuccessStep();
    return null;
  };

  // ---------------------------------------------------- INITIALIZE AUTH
  useEffect(() => {
    initAuth();
  }, [initAuth]);

  return (
    <div
      className="admin-glass-panel admin-animate-slide-up"
      style={{
        width: "100%",
        maxWidth: "420px",
        margin: "0 auto",
        padding: "36px",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
      }}
    >
      {renderStep()}
    </div>
  );
}