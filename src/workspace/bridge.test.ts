import { describe, expect, it, vi } from "vitest";
import {
  FileSystemAccessBridge,
  InMemoryBridge,
  detectNativeBridge
} from "@/workspace/bridge";

type MockHandle = ConstructorParameters<typeof FileSystemAccessBridge>[0];

// Minimal structural mock of FileSystemDirectoryHandle. `entries()` enforces
// the same brand check Chrome does: calling it with the wrong receiver throws
// `TypeError: Illegal invocation`. This makes the walk() regression testable
// (a detached call like `const e = handle.entries; e()` fails the check).
function mockFile(name: string, content: string): MockHandle {
  const handle: MockHandle = {
    kind: "file",
    name,
    async getFile() {
      return {
        size: content.length,
        lastModified: 1700000000000,
        text: async () => content
      };
    },
    async createWritable() {
      return {
        async write(data: string | Blob) {
          content = typeof data === "string" ? data : await data.text();
        },
        async close() {}
      };
    }
  };
  return handle;
}

function mockDir(name: string, children: Record<string, MockHandle>): MockHandle {
  const handle: MockHandle = {
    kind: "directory",
    name,
    async *entries() {
      if (this !== handle) throw new TypeError("Illegal invocation");
      for (const [childName, child] of Object.entries(children)) {
        yield [childName, child];
      }
    },
    async getFileHandle(childName, opts) {
      const child = children[childName];
      if (child && child.kind === "file") return child;
      if (opts?.create) {
        const created = mockFile(childName, "");
        children[childName] = created;
        return created;
      }
      throw new Error(`File not found: ${childName}`);
    },
    async getDirectoryHandle(childName, opts) {
      const child = children[childName];
      if (child && child.kind === "directory") return child;
      if (opts?.create) {
        const created = mockDir(childName, {});
        children[childName] = created;
        return created;
      }
      throw new Error(`Directory not found: ${childName}`);
    },
    async removeEntry(childName) {
      if (!(childName in children)) {
        throw new Error(`Entry not found: ${childName}`);
      }
      delete children[childName];
    }
  };
  return handle;
}

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

describe("FileSystemAccessBridge with a mocked directory handle", () => {
  it("walks a nested folder tree and lists every file with path metadata", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo"),
      src: mockDir("src", {
        "index.ts": mockFile("index.ts", "export {}"),
        auth: mockDir("auth", {
          "login.ts": mockFile("login.ts", "export function login() {}")
        })
      })
    });
    const bridge = new FileSystemAccessBridge(root);
    const list = await bridge.list();
    const paths = list.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "src/auth/login.ts", "src/index.ts"]);
    const login = list.find((f) => f.path === "src/auth/login.ts");
    expect(login?.size).toBe("export function login() {}".length);
    expect(login?.mtime).toBe(1700000000000);
  });

  it("skips ignored directories", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo"),
      node_modules: mockDir("node_modules", {
        "lodash.js": mockFile("lodash.js", "big")
      }),
      ".git": mockDir(".git", { config: mockFile("config", "x") }),
      src: mockDir("src", { "index.ts": mockFile("index.ts", "export {}") })
    });
    const bridge = new FileSystemAccessBridge(root);
    const list = await bridge.list();
    expect(list.map((f) => f.path).sort()).toEqual(["README.md", "src/index.ts"]);
  });

  it("throws loudly (never silently returns zero) when a handle lacks entries()", async () => {
    // A directory handle without an entries() function: before the fix this
    // silently made discovery report "0 files indexed". Now it surfaces the
    // real condition so the store can classify it and the UI can show it.
    const root: MockHandle = { kind: "directory", name: "broken" };
    const bridge = new FileSystemAccessBridge(root);
    await expect(bridge.list()).rejects.toThrow(
      /does not support folder iteration/
    );
  });

  it("discovers an empty folder without error and reports scan counts", async () => {
    const root = mockDir("empty", {});
    const bridge = new FileSystemAccessBridge(root);
    const list = await bridge.list();
    expect(list).toEqual([]);
    expect(bridge.lastScan).toEqual({ entries: 0, files: 0 });
  });

  it("reports discovery counts from the last scan", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo"),
      src: mockDir("src", {
        "index.ts": mockFile("index.ts", "export {}"),
        auth: mockDir("auth", { "login.ts": mockFile("login.ts", "x") })
      }),
      node_modules: mockDir("node_modules", { "lodash.js": mockFile("lodash.js", "big") })
    });
    const bridge = new FileSystemAccessBridge(root);
    const list = await bridge.list();
    // Scanned entries: README.md + src at the root, index.ts + auth inside src,
    // login.ts inside auth = 5. node_modules is skipped before being counted.
    expect(bridge.lastScan.entries).toBe(5);
    expect(bridge.lastScan.files).toBe(list.length);
  });

  it("stops walking after the scanned-file cap", async () => {
    const children: Record<string, MockHandle> = {};
    for (let i = 0; i < 5001; i++) {
      children[`f${i}.ts`] = mockFile(`f${i}.ts`, "x");
    }
    const bridge = new FileSystemAccessBridge(mockDir("big", children));
    const list = await bridge.list();
    expect(list).toHaveLength(5000);
  });

  it("respects the maximum scan depth", async () => {
    let children: Record<string, MockHandle> = {};
    for (let depth = 0; depth < 14; depth++) {
      children[`f${depth}.ts`] = mockFile(`f${depth}.ts`, "x");
      children = { [`d${depth}`]: mockDir(`d${depth}`, children) };
    }
    const root = mockDir("deep", children);
    const bridge = new FileSystemAccessBridge(root);
    const list = await bridge.list();
    const depths = list.map((f) => f.path.split("/").length);
    expect(list.length).toBeGreaterThan(0);
    expect(Math.max(...depths)).toBeLessThanOrEqual(13);
  });

  it("reads a nested file through the resolved handle", async () => {
    const root = mockDir("my-project", {
      src: mockDir("src", {
        auth: mockDir("auth", {
          "login.ts": mockFile("login.ts", "export function login() {}")
        })
      })
    });
    const bridge = new FileSystemAccessBridge(root);
    expect(await bridge.read("src/auth/login.ts")).toBe(
      "export function login() {}"
    );
  });

  it("creates, writes, deletes, and renames files in the folder", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo")
    });
    const bridge = new FileSystemAccessBridge(root);

    await bridge.create("src/new.ts", "export const n = 1;");
    expect(await bridge.read("src/new.ts")).toBe("export const n = 1;");

    await bridge.write("src/new.ts", "export const n = 2;");
    expect(await bridge.read("src/new.ts")).toBe("export const n = 2;");

    await bridge.rename("src/new.ts", "src/renamed.ts");
    await expect(bridge.read("src/new.ts")).rejects.toThrow();
    expect(await bridge.read("src/renamed.ts")).toBe("export const n = 2;");

    await bridge.delete("src/renamed.ts");
    await expect(bridge.read("src/renamed.ts")).rejects.toThrow();
  });

  it("stops walking after the bridge is closed", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo"),
      src: mockDir("src", { "index.ts": mockFile("index.ts", "export {}") })
    });
    const bridge = new FileSystemAccessBridge(root);
    await bridge.close();
    expect(await bridge.list()).toEqual([]);
  });

  it("pick() uses window.showDirectoryPicker and adopts the chosen handle", async () => {
    const root = mockDir("my-project", {
      "README.md": mockFile("README.md", "# demo")
    });
    const picker = vi.fn(async () => root);
    Object.defineProperty(window, "showDirectoryPicker", {
      value: picker,
      configurable: true,
      writable: true
    });
    try {
      const bridge = await FileSystemAccessBridge.pick();
      expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(bridge.rootLabel).toBe("my-project");
      const list = await bridge.list();
      expect(list.map((f) => f.path)).toEqual(["README.md"]);
    } finally {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
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