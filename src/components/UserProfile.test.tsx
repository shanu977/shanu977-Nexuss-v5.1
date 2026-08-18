import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import UserProfile from "@/components/UserProfile";

describe("UserProfile", () => {
  it("shows the avatar and email", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" />);
    expect(screen.getByText("alice@nexuss.in")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("does not contain Settings or Log out", () => {
    render(<UserProfile email="alice@nexuss.in" avatarChar="A" />);
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
  });
});