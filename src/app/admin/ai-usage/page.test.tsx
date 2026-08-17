import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getAiUsage: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getAiUsage: mocks.getAiUsage,
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
    BarChart: box("bar-chart"),
    Bar: () => null,
    PieChart: box("pie-chart"),
    Pie: () => null,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

import { render, screen, cleanup } from "@testing-library/react";
import AdminAiUsagePage from "@/app/admin/ai-usage/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const usage = {
  period: { from_ms: 1, to_ms: 2 },
  filters: {},
  totals: {
    total_users: 0,
    active_users: 0,
    total_requests: 1000,
    successful_requests: 950,
    failed_requests: 50,
    input_tokens: 10000,
    output_tokens: 5000,
    total_tokens: 15000,
    requests_today: 0,
  },
  series: [
    { date: "2026-01-01", requests: 100, successful: 95, failed: 5, input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
  ],
  by_provider: [{ key: "openai", requests: 800, successful: 780, failed: 20, total_tokens: 10000 }],
  by_model: [{ key: "gpt-4o", requests: 500, successful: 490, failed: 10, total_tokens: 8000 }],
  by_status: [{ key: "success", requests: 950, successful: 950, failed: 0, total_tokens: 14000 }],
  by_request_type: [{ key: "chat", requests: 1000, successful: 950, failed: 50, total_tokens: 15000 }],
};

describe("AdminAiUsagePage", () => {
  it("renders KPIs and chart panels from the API response", async () => {
    mocks.getAiUsage.mockResolvedValue(usage);

    render(<AdminAiUsagePage />);

    expect(await screen.findByText("AI Usage & Provider Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Total Requests")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("Successful")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    expect(screen.getByText("AI Requests Over Time")).toBeInTheDocument();
    expect(screen.getByText("Provider Distribution")).toBeInTheDocument();
    expect(screen.getByText("Requests By Model")).toBeInTheDocument();
    expect(screen.getByText("Requests By Status")).toBeInTheDocument();
    expect(screen.getByText("Requests By Request Type")).toBeInTheDocument();
    expect(screen.getByText("Errors By Provider")).toBeInTheDocument();
  });

  it("renders the error state when the API call fails", async () => {
    mocks.getAiUsage.mockRejectedValue(new Error("boom"));

    render(<AdminAiUsagePage />);

    expect(await screen.findByText("Unable to load AI analytics.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});