import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SearchBar } from "@/components/admin/SearchBar";

afterEach(() => {
  cleanup();
});

describe("SearchBar", () => {
  it("renders the placeholder and controlled value", () => {
    render(<SearchBar value="alice" onChange={() => {}} placeholder="Search users..." />);
    const input = screen.getByLabelText("Search users...");
    expect(input).toHaveValue("alice");
  });

  it("notifies onChange as the user types", () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} placeholder="Search..." />);
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
  });
});