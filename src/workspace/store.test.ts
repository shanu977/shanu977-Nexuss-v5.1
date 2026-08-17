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
    expect(s.status).toBe("connected");
    expect(s.discoveredFiles).toBe(s.index?.files.length);
    expect(s.manifest?.files).toEqual(
      s.index?.files.map((f) => f.path).sort()
    );
    expect(s.manifest?.directories).toContain("src/auth");
  });

  it("disconnect clears the workspace and index", async () => {
    await useWorkspaceStore.getState().connectDemo();
    await useWorkspaceStore.getState().disconnect();
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(false);
    expect(s.index).toBeNull();
    expect(s.workspace).toBeNull();
    expect(s.manifest).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("connectLocal classifies browser-support failures", async () => {
    // jsdom has no showDirectoryPicker and no native bridge.
    await useWorkspaceStore.getState().connectLocal();
    const s = useWorkspaceStore.getState();
    expect(s.connected).toBe(false);
    expect(s.status).toBe("error");
    expect(s.errorKind).toBe("unsupported-browser");
    expect(s.error).toMatch(/does not support folder access/i);
  });

  it("clearError resets the error and returns to idle", async () => {
    await useWorkspaceStore.getState().connectLocal();
    useWorkspaceStore.getState().clearError();
    const s = useWorkspaceStore.getState();
    expect(s.error).toBeNull();
    expect(s.errorKind).toBeNull();
    expect(s.status).toBe("idle");
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

  it("answers status questions with a workspace status context", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore.getState().buildContextFor(
      "Can you see my folder?"
    );
    expect(result).not.toBeNull();
    expect(result!.contextText).toContain("is connected");
    expect(result!.contextText).not.toContain("### src/");
    expect(result!.includedFiles).toEqual([]);
  });

  it("answers manifest questions with the workspace file list", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore.getState().buildContextFor(
      "What files are in my project?"
    );
    expect(result).not.toBeNull();
    expect(result!.contextText).toContain("src/auth/login.ts");
    expect(result!.contextText).toContain("Directories:");
  });
});

describe("conversation-aware workspace references", () => {
  it("records search results as resolvable file references", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().buildContextFor("find the python files");
    const s = useWorkspaceStore.getState();
    expect(s.lastSearchResults.length).toBeGreaterThan(0);
    expect(s.lastSearchResults).toContain("server/api.py");
  });

  it("resolves 'the first one' to the first previous search result", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().buildContextFor("find the python files");
    const result = useWorkspaceStore
      .getState()
      .buildContextFor("open the first one");
    expect(result).not.toBeNull();
    expect(result!.includedFiles).toEqual(["server/api.py"]);
    expect(useWorkspaceStore.getState().lastReferencedFile).toBe("server/api.py");
  });

  it("resolves 'it' to the previously referenced file", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const s = useWorkspaceStore.getState();
    s.buildContextFor("find the python files");
    s.buildContextFor("open the first one");
    const result = s.buildContextFor("what does it do?");
    expect(result).not.toBeNull();
    expect(result!.includedFiles).toEqual(["server/api.py"]);
    expect(result!.contextText).toContain("server/api.py");
  });

  it("resolves 'what is inside it?' to the workspace manifest", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore
      .getState()
      .buildContextFor("What is inside it?");
    expect(result).not.toBeNull();
    expect(result!.contextText).toContain("Directories:");
  });

  it("asks for clarification on an ambiguous 'that file'", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().buildContextFor("find the python files");
    const result = useWorkspaceStore.getState().buildContextFor("open that file");
    expect(result).not.toBeNull();
    expect(result!.contextText).toMatch(/which file/i);
    expect(useWorkspaceStore.getState().lastReferencedFile).toBeNull();
  });

  it("resolves 'fix this code' to the referenced workspace file", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const s = useWorkspaceStore.getState();
    s.buildContextFor("find the python files");
    s.buildContextFor("open the first one");
    const result = s.buildContextFor("fix this code");
    expect(result).not.toBeNull();
    expect(result!.includedFiles).toEqual(["server/api.py"]);
  });

  it("resolves 'what was the folder name?' to the actual workspace name", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const result = useWorkspaceStore
      .getState()
      .buildContextFor("What was the folder name?");
    expect(result).not.toBeNull();
    expect(result!.contextText).toContain("nexuss-sample");
  });

  it("reports disconnected state for workspace questions without a workspace", async () => {
    const result = useWorkspaceStore
      .getState()
      .buildContextFor("Can you see my folder?");
    expect(result).not.toBeNull();
    expect(result!.contextText).toMatch(/no folder/i);
  });

  it("does not hallucinate files for 'List my files' without a workspace", async () => {
    const result = useWorkspaceStore.getState().buildContextFor("List my files.");
    expect(result).not.toBeNull();
    expect(result!.contextText).toMatch(/no folder/i);
    expect(result!.contextText).not.toMatch(/src\/auth/);
  });

  it("does not retrieve workspace files for normal chat", async () => {
    await useWorkspaceStore.getState().connectDemo();
    expect(
      useWorkspaceStore.getState().buildContextFor("What is recursion?")
    ).toBeNull();
  });

  it("keeps context within the file and token limits", async () => {
    await useWorkspaceStore.getState().connectDemo();
    const s = useWorkspaceStore.getState();
    const results = s.buildContextFor("find the python files");
    expect(results!.includedFiles.length).toBeLessThanOrEqual(20);
    expect(results!.estimatedTokens).toBeLessThanOrEqual(6000);
    const file = s.buildContextFor("open the first one");
    expect(file!.includedFiles.length).toBeLessThanOrEqual(20);
    expect(file!.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it("clears references when switching workspaces", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().buildContextFor("find the python files");
    expect(useWorkspaceStore.getState().lastSearchResults.length).toBeGreaterThan(0);
    await useWorkspaceStore.getState().connectDemo();
    const s = useWorkspaceStore.getState();
    expect(s.lastSearchResults).toEqual([]);
    expect(s.lastReferencedFile).toBeNull();
  });

  it("clears references when disconnecting", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.getState().buildContextFor("find the python files");
    await useWorkspaceStore.getState().disconnect();
    const s = useWorkspaceStore.getState();
    expect(s.lastSearchResults).toEqual([]);
    expect(s.lastReferencedFile).toBeNull();
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