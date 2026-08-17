import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilterDropdown } from "@/components/admin/FilterDropdown";

afterEach(() => {
  cleanup();
});

describe("FilterDropdown", () => {
  it("renders options and notifies onChange", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        value="All"
        onChange={onChange}
        options={[
          { label: "All Statuses", value: "All" },
          { label: "Active", value: "Active" },
        ]}
        label="Status"
      />
    );
    const select = screen.getByLabelText("Status");
    expect(select).toHaveValue("All");
    fireEvent.change(select, { target: { value: "Active" } });
    expect(onChange).toHaveBeenCalledWith("Active");
  });

  it("supports plain string options", () => {
    render(
      <FilterDropdown
        value="a"
        onChange={() => {}}
        options={["a", "b"]}
        label="Letter"
      />
    );
    const select = screen.getByLabelText("Letter");
    expect(select).toHaveValue("a");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});