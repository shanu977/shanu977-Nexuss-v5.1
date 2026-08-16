import { describe, expect, it } from "vitest";
import { InMemoryBridge, detectNativeBridge } from "@/workspace/bridge";

describe("InMemoryBridge", () => {
  const files = {
    "README.md": "# demo",
    "src/auth/login.ts": "export function login() {}"
  };

  it("lists files with size metadata", async () => {
    const bridge = new InMemoryBridge("demo", files);
    const list = await bridge.list();
    expect(list).toHaveLength(2);
    const readme = list.find((f) => f.path === "README.md");
    expect(readme?.size).toBe("# demo".length);
    expect(readme?.content).toBe("# demo");
  });

  it("reads, creates, writes, deletes, and renames", async () => {
    const bridge = new InMemoryBridge("demo", files);

    await bridge.create("NEW.md", "fresh");
    expect(await bridge.read("NEW.md")).toBe("fresh");

    await bridge.write("NEW.md", "updated");
    expect(await bridge.read("NEW.md")).toBe("updated");

    await bridge.rename("NEW.md", "MOVED.md");
    await expect(bridge.read("NEW.md")).rejects.toThrow();
    expect(await bridge.read("MOVED.md")).toBe("updated");

    await bridge.delete("MOVED.md");
    expect((await bridge.list()).some((f) => f.path === "MOVED.md")).toBe(false);
  });

  it("rejects writing/reading a missing file", async () => {
    const bridge = new InMemoryBridge("demo", files);
    await expect(bridge.read("nope.ts")).rejects.toThrow();
    await expect(bridge.write("nope.ts", "x")).rejects.toThrow();
  });
});

describe("detectNativeBridge", () => {
  it("returns null when no desktop bridge is exposed", () => {
    expect(detectNativeBridge()).toBeNull();
  });

  it("adopts a compliant window.nexussDesktop.workspace", () => {
    const workspace = {
      kind: "native" as const,
      rootLabel: "my-project",
      list: async () => [],
      read: async () => "",
      create: async () => {},
      write: async () => {},
      delete: async () => {},
      rename: async () => {},
      close: async () => {}
    };
    (window as unknown as { nexussDesktop?: unknown }).nexussDesktop = {
      workspace
    };
    try {
      expect(detectNativeBridge()).toBe(workspace);
    } finally {
      delete (window as unknown as { nexussDesktop?: unknown }).nexussDesktop;
    }
  });
});