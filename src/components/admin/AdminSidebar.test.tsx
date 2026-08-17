import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const signOut = vi.fn().mockResolvedValue(undefined);
  return { replace, signOut };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/users",
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { uid: "admin-1" }, signOut: mocks.signOut }),
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AdminSidebar, ADMIN_NAV } from "@/components/admin/AdminSidebar";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminSidebar", () => {
  it("renders every nav destination", () => {
    render(<AdminSidebar />);
    for (const item of ADMIN_NAV) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
    expect(screen.getByText("Back to app")).toBeInTheDocument();
    expect(screen.getByText("Logout")).toBeInTheDocument();
  });

  it("signs out and redirects to /admin/login", async () => {
    render(<AdminSidebar />);
    fireEvent.click(screen.getByText("Logout"));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/admin/login"));
  });

  it("closes the mobile drawer when a nav link is clicked", () => {
    const onCloseMobile = vi.fn();
    render(<AdminSidebar onCloseMobile={onCloseMobile} />);
    fireEvent.click(screen.getByText("Dashboard"));
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
  });
});