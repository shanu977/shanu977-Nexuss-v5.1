import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getAudit: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getAudit: mocks.getAudit,
  },
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AdminSecurityPage from "@/app/admin/security/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const entry = {
  id: "audit-1",
  admin_user_id: "adm-1",
  admin_email: "admin@nexuss.dev",
  admin_name: "Root Admin",
  action: "user.role.updated",
  target_type: "user",
  target_id: "u1",
  details: { role: "admin" },
  ip_address: "10.0.0.1",
  created_at: 1700000000000,
};

const list = {
  items: [entry],
  total: 1,
  page: 1,
  page_size: 25,
  pages: 1,
};

describe("AdminSecurityPage", () => {
  it("renders audit entries from the API", async () => {
    mocks.getAudit.mockResolvedValue(list);

    render(<AdminSecurityPage />);

    expect(await screen.findByText("Root Admin")).toBeInTheDocument();
    expect(screen.getAllByText("user.role.updated").length).toBeGreaterThan(0);
    expect(screen.getByText("u1")).toBeInTheDocument();
  });

  it("opens the details modal with parsed details JSON", async () => {
    mocks.getAudit.mockResolvedValue(list);

    render(<AdminSecurityPage />);

    fireEvent.click(await screen.findByRole("button", { name: /view details/i }));
    expect(screen.getByText("AUDIT EVENT")).toBeInTheDocument();
    expect(screen.getByText(/\"role\": \"admin\"/)).toBeInTheDocument();
  });

  it("renders the empty state when no events match", async () => {
    mocks.getAudit.mockResolvedValue({ ...list, items: [], total: 0 });

    render(<AdminSecurityPage />);

    expect(await screen.findByText("No audit events")).toBeInTheDocument();
  });

  it("renders the error state when the API fails", async () => {
    mocks.getAudit.mockRejectedValue(new Error("boom"));

    render(<AdminSecurityPage />);

    expect(await screen.findByText("Unable to load data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});