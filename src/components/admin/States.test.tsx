import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EmptyState, ErrorState, SkeletonLoader } from "@/components/admin/States";

afterEach(() => {
  cleanup();
});

describe("States", () => {
  it("EmptyState renders title and message", () => {
    render(<EmptyState title="No feedback found" message="Try changing your filters." />);
    expect(screen.getByText("No feedback found")).toBeInTheDocument();
    expect(screen.getByText("Try changing your filters.")).toBeInTheDocument();
  });

  it("ErrorState calls onRetry", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Unable to load data." onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("SkeletonLoader renders the requested number of rows", () => {
    const { container } = render(<SkeletonLoader count={3} />);
    expect(container.querySelectorAll(".admin-skeleton")).toHaveLength(3);
  });
});