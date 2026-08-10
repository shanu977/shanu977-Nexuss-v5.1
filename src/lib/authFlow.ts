export interface UserStatus {
  exists: boolean;
  providers: string[];
  has_password: boolean;
}

// Only a Google-only account (Google provider present, no password) is offered
// the "Set Password" flow. Normal password accounts and accounts that already
// have a password must never see it.
export function shouldShowSetPassword(status: UserStatus | null): boolean {
  return (
    !!status &&
    status.exists &&
    !status.has_password &&
    status.providers.includes("google.com")
  );
}

export function isCompleteOtp(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function validateNewPassword(
  password: string,
  confirm: string
): string | null {
  if (password.length < 6) {
    return "Password must be at least 6 characters long.";
  }
  if (password !== confirm) {
    return "Passwords do not match.";
  }
  return null;
}

export function validateUsername(username: string): string | null {
  if (!username || !username.trim()) {
    return "Username is required.";
  }
  if (username.trim().length > 30) {
    return "Username must be 30 characters or fewer.";
  }
  return null;
}

export function validateEmailAddress(email: string): string | null {
  if (!email || !email.trim()) {
    return "Email is required.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Enter a valid email.";
  }
  return null;
}

export function validateRegistrationPassword(password: string): string | null {
  if (!password) {
    return "Password is required.";
  }
  if (password.length < 6) {
    return "Password must be at least 6 characters long.";
  }
  return null;
}

export function validateConfirmPassword(
  password: string,
  confirm: string
): string | null {
  if (!confirm) {
    return "Confirm password is required.";
  }
  if (password !== confirm) {
    return "Passwords do not match.";
  }
  return null;
}

// First validation failure wins, in field order.
export function validateRegistration(
  username: string,
  email: string,
  password: string,
  confirm: string
): string | null {
  return (
    validateUsername(username) ??
    validateEmailAddress(email) ??
    validateRegistrationPassword(password) ??
    validateConfirmPassword(password, confirm)
  );
}

// Map Firebase error codes to safe, user-friendly messages. Firebase internal
// error details are never surfaced directly to the user.
export function getRegistrationErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "auth/email-already-in-use":
      return "This email is already registered. Please log in instead.";
    case "auth/invalid-email":
      return "Enter a valid email.";
    case "auth/weak-password":
      return "Password must be at least 6 characters long.";
    case "auth/network-request-failed":
      return "Network error. Check your connection.";
    default:
      return "Failed to create your account. Please try again.";
  }
}
