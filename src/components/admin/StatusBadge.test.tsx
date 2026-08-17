import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusBadge } from "@/components/admin/StatusBadge";

afterEach(() => {
  cleanup();
});

describe("StatusBadge", () => {
  it("renders the status text", () => {
    render(<StatusBadge status="new" />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("defaults to active when no status is given", () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("maps feedback triage statuses", () => {
    const { rerender } = render(<StatusBadge status="new" />);
    expect(screen.getByText("new")).toBeInTheDocument();
    rerender(<StatusBadge status="reviewed" />);
    expect(screen.getByText("reviewed")).toBeInTheDocument();
    rerender(<StatusBadge status="closed" />);
    expect(screen.getByText("closed")).toBeInTheDocument();
  });

  it("maps user role and status", () => {
    const { rerender } = render(<StatusBadge status="admin" />);
    expect(screen.getByText("admin")).toBeInTheDocument();
    rerender(<StatusBadge status="blocked" />);
    expect(screen.getByText("blocked")).toBeInTheDocument();
    rerender(<StatusBadge status="active" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });
});