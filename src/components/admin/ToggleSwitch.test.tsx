import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToggleSwitch } from "@/components/admin/ToggleSwitch";

afterEach(() => {
  cleanup();
});

describe("ToggleSwitch", () => {
  it("renders a switch with the checked state", () => {
    render(<ToggleSwitch checked={true} onChange={() => {}} label="AI enabled" />);
    const toggle = screen.getByRole("switch", { name: "AI enabled" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggles on click", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="Flag" />);
    fireEvent.click(screen.getByRole("switch", { name: "Flag" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire when disabled", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="Flag" disabled />);
    fireEvent.click(screen.getByRole("switch", { name: "Flag" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});