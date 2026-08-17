import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getFeedback: vi.fn(),
    updateFeedback: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getFeedback: mocks.getFeedback,
    updateFeedback: mocks.updateFeedback,
  },
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AdminFeedbackPage from "@/app/admin/feedback/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const feedback = {
  id: "fb-1",
  user: { id: "u1", email: "alice@example.com", name: "Alice" },
  rating: 5,
  message: "Loved the chatbot, it saved me hours!",
  status: "new" as const,
  created_at: 1700000000000,
};

const list = {
  items: [feedback],
  total: 1,
  page: 1,
  page_size: 20,
  pages: 1,
};

describe("AdminFeedbackPage", () => {
  it("renders feedback items from the API", async () => {
    mocks.getFeedback.mockResolvedValue(list);

    render(<AdminFeedbackPage />);

    expect(await screen.findByText(/Loved the chatbot/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("5.0")).toBeInTheDocument();
  });

  it("opens the details modal and updates the triage status", async () => {
    mocks.getFeedback.mockResolvedValue(list);
    mocks.updateFeedback.mockResolvedValue({ ...feedback, status: "reviewed" });

    render(<AdminFeedbackPage />);

    fireEvent.click(await screen.findByRole("button", { name: /view details/i }));
    expect(screen.getByText("FEEDBACK DETAILS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reviewed" }));
    await vi.waitFor(() => expect(mocks.updateFeedback).toHaveBeenCalledWith("fb-1", "reviewed"));
  });

  it("renders the empty state when there is no feedback", async () => {
    mocks.getFeedback.mockResolvedValue({ ...list, items: [], total: 0 });

    render(<AdminFeedbackPage />);

    expect(await screen.findByText("No feedback found")).toBeInTheDocument();
  });

  it("renders the error state when the API fails", async () => {
    mocks.getFeedback.mockRejectedValue(new Error("boom"));

    render(<AdminFeedbackPage />);

    expect(await screen.findByText("Unable to load data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});