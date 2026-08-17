import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { KPICard } from "@/components/admin/KPICard";

afterEach(() => {
  cleanup();
});

describe("KPICard", () => {
  it("renders title and value", () => {
    render(<KPICard title="Total Users" value="1,234" type="users" />);
    expect(screen.getByText("Total Users")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("renders subtitle and positive change", () => {
    render(
      <KPICard
        title="Requests"
        value="100"
        change="+12%"
        isPositive={true}
        subtitle="All attempts"
      />
    );
    expect(screen.getByText("+12%")).toBeInTheDocument();
    expect(screen.getByText("All attempts")).toBeInTheDocument();
  });
});