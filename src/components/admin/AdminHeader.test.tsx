import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const signOut = vi.fn().mockResolvedValue(undefined);
  return { signOut };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/dashboard",
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: { displayName: "Jane Admin", email: "jane@example.com", photoURL: null },
      signOut: mocks.signOut,
    }),
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AdminHeader } from "@/components/admin/AdminHeader";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminHeader", () => {
  it("shows the route title and description", () => {
    render(<AdminHeader onOpenMobileMenu={() => {}} />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Overview of your Nexuss platform")).toBeInTheDocument();
  });

  it("opens the mobile menu from the menu button", () => {
    const onOpenMobileMenu = vi.fn();
    render(<AdminHeader onOpenMobileMenu={onOpenMobileMenu} />);
    fireEvent.click(screen.getByLabelText("Open menu"));
    expect(onOpenMobileMenu).toHaveBeenCalledTimes(1);
  });

  it("opens the profile menu and signs out", async () => {
    render(<AdminHeader onOpenMobileMenu={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /jane admin/i }));
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sign out"));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
});