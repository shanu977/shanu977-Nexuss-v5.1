import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import AdSlot from "./AdSlot";

const AD_SRC =
  "https://pl30829225.effectivecpmnetwork.com/98/08/a2/9808a269185e74f09da9712dc17c97a4.js";

afterEach(() => {
  cleanup();
  document.getElementById("chat-ad-script")?.remove();
  document.getElementById("chat-ad-slot")?.remove();
});

function injectedScripts() {
  return Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[id='chat-ad-script']")
  );
}

describe("AdSlot (Chat UI ad integration)", () => {
  it("injects the ad script only when mounted", () => {
    render(<AdSlot />);
    const scripts = injectedScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(AD_SRC);
    expect(scripts[0].async).toBe(true);
  });

  it("does not inject a duplicate script across re-renders", () => {
    const { rerender } = render(<AdSlot />);
    rerender(<AdSlot />);
    expect(injectedScripts()).toHaveLength(1);
  });

  it("renders a dedicated responsive container for the ad", () => {
    const { container } = render(<AdSlot />);
    const slot = container.querySelector("#chat-ad-slot");
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveAttribute("aria-label", "Advertisement");
  });

  it("removes the injected script and ad DOM on unmount", () => {
    const { unmount } = render(<AdSlot />);
    expect(injectedScripts()).toHaveLength(1);
    unmount();
    expect(injectedScripts()).toHaveLength(0);
    expect(document.getElementById("chat-ad-slot")).toBeNull();
  });
});