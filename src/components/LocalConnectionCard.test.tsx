import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import LocalConnectionCard from "@/components/LocalConnectionCard";
import {
  useLocalConnectionStore,
  isConnectionCardVisible,
  type LocalConnectionPhase,
} from "@/store/localConnectionStore";

function setPhase(phase: LocalConnectionPhase) {
  useLocalConnectionStore.setState({ phase, detail: null, active: phase !== "idle" });
}

afterEach(() => {
  cleanup();
  useLocalConnectionStore.setState({ phase: "idle", detail: null, active: false });
});

describe("LocalConnectionCard", () => {
  it("renders nothing when idle", () => {
    setPhase("idle");
    const { container } = render(<LocalConnectionCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when connected (verification done, card auto-hides)", () => {
    setPhase("connected");
    const { container } = render(<LocalConnectionCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the checking copy while verifying the connection", () => {
    setPhase("checking");
    render(<LocalConnectionCard />);
    expect(screen.getByText("Connecting to local AI")).toBeInTheDocument();
    expect(screen.getByText("Checking your local AI connection...")).toBeInTheDocument();
    // The live region is announced to assistive tech.
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("shows the starting copy while Ollama is being launched", () => {
    setPhase("starting");
    render(<LocalConnectionCard />);
    expect(screen.getByText("Connecting to local AI")).toBeInTheDocument();
    expect(
      screen.getByText("Starting Ollama and connecting to your local model...")
    ).toBeInTheDocument();
    expect(screen.getByText("This usually takes a few seconds.")).toBeInTheDocument();
  });

  it("shows the waiting copy while health checks poll", () => {
    setPhase("waiting_for_health");
    render(<LocalConnectionCard />);
    expect(screen.getByText("Waiting for local AI to become ready...")).toBeInTheDocument();
    // No secondary line for this phase.
    expect(screen.queryByText("This usually takes a few seconds.")).not.toBeInTheDocument();
  });

  it("never shows technical internals in any phase copy", () => {
    for (const phase of ["checking", "starting", "waiting_for_health"] as const) {
      cleanup();
      setPhase(phase);
      render(<LocalConnectionCard />);
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).not.toMatch(/spawn|shell|ollama\.exe|11435|stack|ECONNREFUSED/i);
    }
  });
});

describe("isConnectionCardVisible", () => {
  it("is visible only for the active work phases", () => {
    expect(isConnectionCardVisible("idle")).toBe(false);
    expect(isConnectionCardVisible("connected")).toBe(false);
    expect(isConnectionCardVisible("checking")).toBe(true);
    expect(isConnectionCardVisible("starting")).toBe(true);
    expect(isConnectionCardVisible("waiting_for_health")).toBe(true);
  });
});
