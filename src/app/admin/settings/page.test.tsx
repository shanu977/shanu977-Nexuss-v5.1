import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  };
});

vi.mock("@/services/admin", () => ({
  adminApi: {
    getSettings: mocks.getSettings,
    updateSettings: mocks.updateSettings,
  },
}));

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AdminSettingsPage from "@/app/admin/settings/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settingsRes = {
  items: [
    {
      id: "s1",
      key: "ai:enabled",
      value: "true",
      value_type: "boolean" as const,
      description: "Master switch for AI features",
      updated_by_email: null,
      created_at: 1,
      updated_at: 1,
    },
    {
      id: "s2",
      key: "max_tokens",
      value: "4096",
      value_type: "number" as const,
      description: null,
      updated_by_email: "admin@nexuss.dev",
      created_at: 1,
      updated_at: 1,
    },
  ],
};

describe("AdminSettingsPage", () => {
  it("renders feature flags and configuration from the API", async () => {
    mocks.getSettings.mockResolvedValue(settingsRes);

    render(<AdminSettingsPage />);

    expect(await screen.findByText("Master switch for AI features")).toBeInTheDocument();
    expect(screen.getAllByText("ai:enabled").length).toBeGreaterThan(0);
    expect(screen.getByText("max_tokens")).toBeInTheDocument();
    expect(screen.getByLabelText(/edit value for max_tokens/i)).toHaveValue("4096");
  });

  it("disabling a boolean flag requires confirmation and persists via the API", async () => {
    mocks.getSettings.mockResolvedValue(settingsRes);
    mocks.updateSettings.mockResolvedValue(settingsRes);

    render(<AdminSettingsPage />);

    fireEvent.click(await screen.findByRole("switch", { name: "ai:enabled" }));

    expect(screen.getByText('Disable "Master switch for AI features"?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, Turn Off" }));

    await vi.waitFor(() => {
      expect(mocks.updateSettings).toHaveBeenCalledWith([
        { key: "ai:enabled", value: "false", value_type: "boolean", description: "Master switch for AI features" },
      ]);
    });
  });

  it("saves an edited configuration value", async () => {
    mocks.getSettings.mockResolvedValue(settingsRes);
    mocks.updateSettings.mockResolvedValue(settingsRes);

    render(<AdminSettingsPage />);

    const input = await screen.findByLabelText(/edit value for max_tokens/i);
    fireEvent.change(input, { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await vi.waitFor(() => {
      expect(mocks.updateSettings).toHaveBeenCalledWith([
        { key: "max_tokens", value: "8192", value_type: "number", description: null },
      ]);
    });
  });

  it("renders the error state when settings cannot load", async () => {
    mocks.getSettings.mockRejectedValue(new Error("boom"));

    render(<AdminSettingsPage />);

    expect(await screen.findByText("Unable to load data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});