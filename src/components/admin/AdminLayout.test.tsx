import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/dashboard",
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: { uid: "admin-1", displayName: "Jane Admin", email: "jane@example.com", photoURL: null },
      signOut: vi.fn().mockResolvedValue(undefined),
    }),
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AdminLayout } from "@/components/admin/AdminLayout";

afterEach(() => {
  cleanup();
});

describe("AdminLayout", () => {
  it("renders children inside the main area", () => {
    render(
      <AdminLayout>
        <div>Page content</div>
      </AdminLayout>
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("renders the sidebar and header", () => {
    render(<AdminLayout>content</AdminLayout>);
    expect(screen.getByText("Overview of your Nexuss platform")).toBeInTheDocument();
    expect(screen.getByText("Logout")).toBeInTheDocument();
  });

  it("opens the mobile drawer via the header menu button", () => {
    render(<AdminLayout>content</AdminLayout>);
    const openMenu = screen.getByLabelText("Open menu");
    fireEvent.click(openMenu);
    expect(screen.getByLabelText("Close menu")).toBeInTheDocument();
  });
});