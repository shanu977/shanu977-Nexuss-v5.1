import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import UserProfile from "@/components/UserProfile";

afterEach(() => {
  cleanup();
});

describe("UserProfile", () => {
  it("shows the avatar and email", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" />);
    expect(screen.getByText("alice@nexuss.in")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("does not contain Settings or Log out without menu handlers", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" />);
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a menu with account, workspace and actions", () => {
    render(
      <UserProfile
        email="alice@nexuss.in"
        avatarChar="A"
        name="Alice"
        workspaceName="My Project"
        onOpenAccount={() => {}}
        onOpenSettings={() => {}}
        onSignOut={() => {}}
      />
    );

    const trigger = screen.getByRole("button", { name: "Open account menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Account menu" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getAllByText("alice@nexuss.in").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Active Workspace").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("My Project").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("menuitem", { name: /Account/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Sign out/ })).toBeInTheDocument();

    // Keyboard users land inside the menu when it opens.
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Account/ }));
  });

  it("shows a placeholder when no workspace folder is connected", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" workspaceName={null} onOpenAccount={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    expect(screen.getAllByText("No folder connected").length).toBeGreaterThanOrEqual(1);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" onOpenSettings={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Open account menu" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when clicking outside the menu", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("runs the Account action and closes the menu", () => {
    const onOpenAccount = vi.fn();
    const onSignOut = vi.fn();
    render(
      <UserProfile
        email="alice@nexuss.in"
        avatarChar="A"
        onOpenAccount={onOpenAccount}
        onSignOut={onSignOut}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /Account/ }));

    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSignOut).not.toHaveBeenCalled();
  });
});
