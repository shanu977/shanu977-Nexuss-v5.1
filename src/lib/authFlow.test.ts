import { describe, expect, it } from "vitest";
import {
  getRegistrationErrorMessage,
  isCompleteOtp,
  shouldShowSetPassword,
  UserStatus,
  validateConfirmPassword,
  validateEmailAddress,
  validateNewPassword,
  validateRegistration,
  validateRegistrationPassword,
  validateUsername
} from "@/lib/authFlow";

const googleOnly: UserStatus = {
  exists: true,
  providers: ["google.com"],
  has_password: false
};
const passwordOnly: UserStatus = {
  exists: true,
  providers: ["password"],
  has_password: true
};
const googleAndPassword: UserStatus = {
  exists: true,
  providers: ["google.com", "password"],
  has_password: true
};
const nonexistent: UserStatus = { exists: false, providers: [], has_password: false };

describe("shouldShowSetPassword", () => {
  it("shows Set Password for a Google-only account", () => {
    expect(shouldShowSetPassword(googleOnly)).toBe(true);
  });

  it("does NOT show Set Password for a normal password account", () => {
    expect(shouldShowSetPassword(passwordOnly)).toBe(false);
  });

  it("does NOT show Set Password for a Google + password account", () => {
    expect(shouldShowSetPassword(googleAndPassword)).toBe(false);
  });

  it("does NOT show Set Password for a nonexistent account", () => {
    expect(shouldShowSetPassword(nonexistent)).toBe(false);
  });

  it("does NOT show Set Password when the status lookup is unavailable", () => {
    expect(shouldShowSetPassword(null)).toBe(false);
  });
});

describe("isCompleteOtp", () => {
  it("accepts exactly six digits", () => {
    expect(isCompleteOtp("123456")).toBe(true);
  });

  it("rejects short, long, or non-digit codes", () => {
    expect(isCompleteOtp("12345")).toBe(false);
    expect(isCompleteOtp("1234567")).toBe(false);
    expect(isCompleteOtp("12ab56")).toBe(false);
    expect(isCompleteOtp("")).toBe(false);
  });
});

describe("validateNewPassword", () => {
  it("rejects a short password", () => {
    expect(validateNewPassword("123", "123")).toBe(
      "Password must be at least 6 characters long."
    );
  });

  it("rejects a password mismatch", () => {
    expect(validateNewPassword("correct-pass", "wrong-pass")).toBe(
      "Passwords do not match."
    );
  });

  it("accepts a matching long password", () => {
    expect(validateNewPassword("correct-pass", "correct-pass")).toBeNull();
  });
});

describe("validateUsername", () => {
  it("requires a username", () => {
    expect(validateUsername("")).toBe("Username is required.");
    expect(validateUsername("   ")).toBe("Username is required.");
  });

  it("rejects an over-long username", () => {
    expect(validateUsername("a".repeat(31))).toBe(
      "Username must be 30 characters or fewer."
    );
  });

  it("accepts a valid username", () => {
    expect(validateUsername("alice")).toBeNull();
    expect(validateUsername("  alice  ")).toBeNull();
  });
});

describe("validateEmailAddress", () => {
  it("requires an email", () => {
    expect(validateEmailAddress("")).toBe("Email is required.");
  });

  it("rejects a malformed email", () => {
    expect(validateEmailAddress("not-an-email")).toBe("Enter a valid email.");
    expect(validateEmailAddress("a@b")).toBe("Enter a valid email.");
  });

  it("accepts a valid email", () => {
    expect(validateEmailAddress("alice@example.com")).toBeNull();
  });
});

describe("validateRegistrationPassword", () => {
  it("requires a password", () => {
    expect(validateRegistrationPassword("")).toBe("Password is required.");
  });

  it("rejects a password shorter than 6 characters", () => {
    expect(validateRegistrationPassword("12345")).toBe(
      "Password must be at least 6 characters long."
    );
  });

  it("accepts a password of at least 6 characters", () => {
    expect(validateRegistrationPassword("123456")).toBeNull();
  });
});

describe("validateConfirmPassword", () => {
  it("requires a confirmation password", () => {
    expect(validateConfirmPassword("123456", "")).toBe(
      "Confirm password is required."
    );
  });

  it("rejects a mismatch", () => {
    expect(validateConfirmPassword("123456", "123457")).toBe(
      "Passwords do not match."
    );
  });

  it("accepts matching passwords", () => {
    expect(validateConfirmPassword("123456", "123456")).toBeNull();
  });
});

describe("validateRegistration", () => {
  it("returns the first validation failure in field order", () => {
    expect(validateRegistration("", "bad", "123", "124")).toBe(
      "Username is required."
    );
    expect(validateRegistration("alice", "bad", "123", "124")).toBe(
      "Enter a valid email."
    );
    expect(validateRegistration("alice", "a@b.co", "123", "124")).toBe(
      "Password must be at least 6 characters long."
    );
    expect(validateRegistration("alice", "a@b.co", "123456", "123457")).toBe(
      "Passwords do not match."
    );
  });

  it("accepts a valid registration", () => {
    expect(
      validateRegistration("alice", "alice@example.com", "123456", "123456")
    ).toBeNull();
  });
});

describe("getRegistrationErrorMessage", () => {
  it("maps Firebase error codes to safe messages", () => {
    expect(
      getRegistrationErrorMessage({ code: "auth/email-already-in-use" })
    ).toBe("This email is already registered. Please log in instead.");
    expect(getRegistrationErrorMessage({ code: "auth/invalid-email" })).toBe(
      "Enter a valid email."
    );
    expect(getRegistrationErrorMessage({ code: "auth/weak-password" })).toBe(
      "Password must be at least 6 characters long."
    );
    expect(
      getRegistrationErrorMessage({ code: "auth/network-request-failed" })
    ).toBe("Network error. Check your connection.");
  });

  it("never surfaces unknown Firebase errors directly", () => {
    expect(getRegistrationErrorMessage({ code: "auth/internal-error" })).toBe(
      "Failed to create your account. Please try again."
    );
    expect(getRegistrationErrorMessage({})).toBe(
      "Failed to create your account. Please try again."
    );
  });
});
