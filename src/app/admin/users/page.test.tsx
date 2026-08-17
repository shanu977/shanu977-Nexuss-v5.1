import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getUsers: vi.fn(),
    updateRole: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    deleteUser: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getUsers: mocks.getUsers,
    updateRole: mocks.updateRole,
    blockUser: mocks.blockUser,
    unblockUser: mocks.unblockUser,
    deleteUser: mocks.deleteUser,
  },
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AdminUsersPage from "@/app/admin/users/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const alice = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  photo_url: null,
  provider: "firebase",
  role: "admin" as const,
  status: "active" as const,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

const bob = {
  id: "u2",
  email: "bob@example.com",
  name: "Bob",
  photo_url: null,
  provider: "google",
  role: "user" as const,
  status: "blocked" as const,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

function listFor(params: { status?: string }) {
  const items = params.status === "active" ? [alice] : params.status === "blocked" ? [bob] : [alice, bob];
  return { items, total: items.length, page: 1, page_size: 20, pages: 1 };
}

describe("AdminUsersPage", () => {
  it("renders the user table and summary cards", async () => {
    mocks.getUsers.mockImplementation((params: { status?: string }) =>
      Promise.resolve(listFor(params ?? {}))
    );

    render(<AdminUsersPage />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("Total Registered")).toBeInTheDocument();
    expect(screen.getByText("Active Accounts")).toBeInTheDocument();
    expect(screen.getByText("Blocked / Suspended")).toBeInTheDocument();
  });

  it("opens the details modal with role change controls", async () => {
    mocks.getUsers.mockImplementation((params: { status?: string }) =>
      Promise.resolve(listFor(params ?? {}))
    );

    render(<AdminUsersPage />);

    fireEvent.click(await screen.findByLabelText("View alice@example.com"));

    expect(screen.getByLabelText("Select role")).toHaveValue("admin");
    expect(screen.getByRole("button", { name: /change role/i })).toBeInTheDocument();
  });

  it("blocking an active user opens a confirmation and calls blockUser", async () => {
    mocks.getUsers.mockImplementation((params: { status?: string }) =>
      Promise.resolve(listFor(params ?? {}))
    );
    mocks.blockUser.mockResolvedValue({ ...alice, status: "blocked" });

    render(<AdminUsersPage />);

    fireEvent.click(await screen.findByLabelText("Block alice@example.com"));
    expect(screen.getByText("Block User Account?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Block Account" }));

    await vi.waitFor(() => expect(mocks.blockUser).toHaveBeenCalledWith("u1"));
  });

  it("delete confirmation requires explicit destructive copy and calls deleteUser", async () => {
    mocks.getUsers.mockImplementation((params: { status?: string }) =>
      Promise.resolve(listFor(params ?? {}))
    );
    mocks.deleteUser.mockResolvedValue({ status: "deleted", id: "u2" });

    render(<AdminUsersPage />);

    fireEvent.click(await screen.findByLabelText("Delete bob@example.com"));
    expect(screen.getByText(/re-provisioned as a fresh account/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete User" }));

    await vi.waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith("u2"));
  });

  it("renders the error state when the list fails to load", async () => {
    mocks.getUsers.mockRejectedValue(new Error("boom"));

    render(<AdminUsersPage />);

    expect(await screen.findByText("Unable to load data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});