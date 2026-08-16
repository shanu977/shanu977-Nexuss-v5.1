import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/workspace/store";
import { DEFAULT_CONTEXT_BUDGET } from "@/workspace/context";

beforeEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  useWorkspaceStore.setState({
    panelOpen: false,
    contextBudget: DEFAULT_CONTEXT_BUDGET
  });
});

afterEach(async () => {
  await useWorkspaceStore.getState().disconnect();
});

describe("workspace store lifecycle", () => {
  it("starts disconnected", () => {
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(false);
    expect(s.workspace).toBeNull();
    expect(s.index).toBeNull();
  });

  it("connectDemo builds an index and marks the workspace connected", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(true);
    expect(s.workspace?.name).toBe("nexuss-sample");
    expect(s.workspace?.kind).toBe("in-memory");
    expect(s.index?.files.length).toBeGreaterThan(0);
    expect(s.index?.byPath.has("src/auth/login.ts")).toBe(true);
  });

  it("disconnect clears the workspace and index", async () => {
    await useWorkspaceStore.getState().connectDemo();
    await useWorkspaceStore.getState().disconnect();
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(false);
    expect(s.index).toBeNull();
    expect(s.workspace).toBeNull();
  });

  it("connectLocal surfaces a clear error in browsers without folder access", async () => {
    // jsdom has no showDirectoryPicker and no native bridge.
    await useWorkspaceStore.getState().connectLocal();
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(false);
    expect(s.error).toBeTruthy();
  });
});

describe("search", () => {
  it("finds demo files and ranks by relevance", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().search("login");
    const s = useWorkspaceStore.getState();
    expect(s.searchResults.length).toBeGreaterThan(0);
    expect(s.searchResults[0].file.path).toBe("src/auth/login.ts");
  });

  it("returns no results when disconnected", () => {
    useWorkspaceStore.getState().search("login");
    expect(useWorkspaceStore.getState().searchResults).toEqual([]);
  });
});

describe("buildContextFor", () => {
  it("returns null when disconnected", () => {
    expect(useWorkspaceStore.getState().buildContextFor("any question")).toBeNull();
  });

  it("returns a token-minimized context for a relevant question", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore.getState().buildContextFor(
      "why does login.ts reject valid users?"
    );
    expect(result).not.toBeNull();
    expect(result!.includedFiles).toContain("src/auth/login.ts");
    expect(result!.estimatedTokens).toBeLessThanOrEqual(
      DEFAULT_CONTEXT_BUDGET.maxTokens
    );
  });

  it("returns null when nothing in the workspace matches", async () => {
    await useWorkspaceStore.getState().connectDemo();
    expect(
      useWorkspaceStore.getState().buildContextFor("zzzznothingmatches")
    ).toBeNull();
  });

  it("selects only relevant files, never the whole project", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore.getState().buildContextFor("login bug");
    expect(result).not.toBeNull();
    // The relevant auth files are selected...
    expect(result!.includedFiles).toContain("src/auth/login.ts");
    // ...while an irrelevant file is left out, and the payload is small.
    expect(result!.includedFiles).not.toContain("src/utils/format.ts");
    expect(result!.contextText.length).toBeLessThan(20000);
  });
});

describe("safe file operations", () => {
  it("create/write/delete/rename succeed and refresh the index", async () => {
    await useWorkspaceStore.getState().connectDemo();

    const created = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "create", path: "notes.md", content: "# note" });
    expect(created.ok).toBe(true);
    expect(useWorkspaceStore.getState().index?.byPath.has("notes.md")).toBe(true);

    const written = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "write", path: "notes.md", content: "# updated" });
    expect(written.ok).toBe(true);
    expect(
      useWorkspaceStore.getState().index?.byPath.get("notes.md")?.chunks.join("\n")
    ).toBe("# updated");

    const renamed = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "rename", from: "notes.md", to: "renamed.md" });
    expect(renamed.ok).toBe(true);
    expect(useWorkspaceStore.getState().index?.byPath.has("notes.md")).toBe(false);
    expect(useWorkspaceStore.getState().index?.byPath.has("renamed.md")).toBe(true);

    const deleted = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "delete", path: "renamed.md" });
    expect(deleted.ok).toBe(true);
    expect(useWorkspaceStore.getState().index?.byPath.has("renamed.md")).toBe(false);
  });

  it("rejects path traversal and absolute paths", async () => {
    await useWorkspaceStore.getState().connectDemo();

    const escape = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "create", path: "../outside.txt", content: "x" });
    expect(escape.ok).toBe(false);
    expect(escape.error).toContain("escapes");

    const absolute = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "write", path: "C:\\Windows\\x.txt", content: "x" });
    expect(absolute.ok).toBe(false);

    const deleteEscape = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "delete", path: "../../evil" });
    expect(deleteEscape.ok).toBe(false);
  });

  it("fails cleanly when no workspace is connected", async () => {
    const result = await useWorkspaceStore
      .getState()
      .applyOperation({ type: "create", path: "a.md", content: "" });
    expect(result.ok).toBe(false);
  });
});

describe("panel + budget", () => {
  it("open/close/toggle the panel", () => {
    const s = useWorkspaceStore.getState();
    s.openPanel();
    expect(useWorkspaceStore.getState().panelOpen).toBe(true);
    s.closePanel();
    expect(useWorkspaceStore.getState().panelOpen).toBe(false);
  });

  it("merges context budget updates", () => {
    useWorkspaceStore.getState().setContextBudget({ maxTokens: 8000 });
    expect(useWorkspaceStore.getState().contextBudget.maxTokens).toBe(8000);
    expect(useWorkspaceStore.getState().contextBudget.maxFiles).toBe(
      DEFAULT_CONTEXT_BUDGET.maxFiles
    );
  });
});