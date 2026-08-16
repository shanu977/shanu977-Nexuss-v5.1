import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspacePanel from "@/components/WorkspacePanel";
import { useWorkspaceStore } from "@/workspace/store";

beforeEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  useWorkspaceStore.getState().closePanel();
});

afterEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  cleanup();
});

describe("WorkspacePanel", () => {
  it("shows connect controls when no workspace is connected", () => {
    render(<WorkspacePanel />);
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect a folder" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try sample workspace" })
    ).toBeInTheDocument();
  });

  it("connects the sample workspace and shows the indexed file count", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    expect(await screen.findByText(/files indexed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().connected).toBe(true);
  });

  it("runs a hybrid search and lists ranked results", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "login" } });

    const result = await screen.findByText("src/auth/login.ts");
    expect(result).toBeInTheDocument();
  });

  it("shows no-matches feedback for an unmatched query", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "zzzznothing" } });

    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });

  it("closes the panel via the header close button", () => {
    useWorkspaceStore.getState().openPanel();
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByLabelText("Close workspace panel"));
    expect(useWorkspaceStore.getState().panelOpen).toBe(false);
  });

  it("surfaces a browser-support error when folder access is unavailable", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not support folder access/i
    );
  });

  it("starts collapsed and expands via the header toggle", () => {
    render(<WorkspacePanel />);
    const toggle = screen.getByRole("button", { name: /Path/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Connect a folder" })
    ).toBeInTheDocument();
  });

  it("keeps the connection and search query across collapse/expand", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "login" } });
    await screen.findByText("src/auth/login.ts");

    const toggle = screen.getByRole("button", { name: /Path/i });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(useWorkspaceStore.getState().connected).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Search workspace")).toHaveValue("login");
    expect(useWorkspaceStore.getState().connected).toBe(true);
  });
});