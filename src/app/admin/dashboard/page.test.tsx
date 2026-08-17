import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getAnalyticsSummary: vi.fn(),
    getAiUsage: vi.fn(),
    getUsers: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getAnalyticsSummary: mocks.getAnalyticsSummary,
    getAiUsage: mocks.getAiUsage,
    getUsers: mocks.getUsers,
  },
}));

vi.mock("recharts", async () => {
  const React = await import("react");
  const box = (testId: string) => ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": testId }, children);
  return {
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { style: { width: 200, height: 200 } }, children),
    LineChart: box("line-chart"),
    Line: () => null,
    PieChart: box("pie-chart"),
    Pie: () => null,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

import { render, screen, cleanup } from "@testing-library/react";
import AdminDashboardPage from "@/app/admin/dashboard/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const summary = {
  period: { from_ms: 1, to_ms: 2 },
  totals: {
    total_users: 120,
    active_users: 80,
    total_requests: 1000,
    successful_requests: 950,
    failed_requests: 50,
    input_tokens: 10000,
    output_tokens: 5000,
    total_tokens: 15000,
    requests_today: 42,
  },
};

const usage = {
  period: { from_ms: 1, to_ms: 2 },
  filters: {},
  totals: summary.totals,
  series: [
    { date: "2026-01-01", requests: 100, successful: 95, failed: 5, input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
  ],
  by_provider: [{ key: "openai", requests: 800, successful: 780, failed: 20, total_tokens: 10000 }],
  by_model: [{ key: "gpt-4o", requests: 500, successful: 490, failed: 10, total_tokens: 8000 }],
  by_status: [{ key: "success", requests: 950, successful: 950, failed: 0, total_tokens: 14000 }],
  by_request_type: [{ key: "chat", requests: 1000, successful: 950, failed: 50, total_tokens: 15000 }],
};

const user = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  photo_url: null,
  provider: "firebase",
  role: "admin",
  status: "active",
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

describe("AdminDashboardPage", () => {
  it("renders KPIs, charts and recent users from the real API responses", async () => {
    mocks.getAnalyticsSummary.mockResolvedValue(summary);
    mocks.getAiUsage.mockResolvedValue(usage);
    mocks.getUsers.mockResolvedValue({
      items: [user],
      total: 1,
      page: 1,
      page_size: 5,
      pages: 1,
    });

    render(<AdminDashboardPage />);

    expect(await screen.findByText("Total Users")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Active Users")).toBeInTheDocument();
    expect(screen.getAllByText("Total Requests").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1,000").length).toBeGreaterThan(0);
    expect(screen.getByText("Requests Today")).toBeInTheDocument();

    expect(screen.getByText("AI Requests Overview")).toBeInTheDocument();
    expect(screen.getByText("Requests By Provider")).toBeInTheDocument();
    expect(screen.getByText("Top Models")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();

    expect(screen.getByText("Recent Users")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("renders the error state when the API calls fail", async () => {
    mocks.getAnalyticsSummary.mockRejectedValue(new Error("boom"));
    mocks.getAiUsage.mockRejectedValue(new Error("boom"));
    mocks.getUsers.mockRejectedValue(new Error("boom"));

    render(<AdminDashboardPage />);

    expect(await screen.findByText("Failed to load Nexuss dashboard metrics.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});