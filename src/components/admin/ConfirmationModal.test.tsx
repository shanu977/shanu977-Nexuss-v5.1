import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmationModal } from "@/components/admin/ConfirmationModal";

afterEach(() => {
  cleanup();
});

describe("ConfirmationModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmationModal isOpen={false} onClose={() => {}} onConfirm={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title, message and buttons when open", () => {
    render(
      <ConfirmationModal
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
        title="Delete User Permanently?"
        message="This cannot be undone."
        confirmText="Delete User"
        cancelText="Cancel"
        isDanger={true}
      />
    );
    expect(screen.getByText("Delete User Permanently?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete User" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onConfirm and onClose", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmationModal
        isOpen={true}
        onClose={onClose}
        onConfirm={onConfirm}
        confirmText="Confirm"
        cancelText="Cancel"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});