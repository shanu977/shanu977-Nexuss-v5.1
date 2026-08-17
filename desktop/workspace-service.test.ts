import { describe, expect, it } from "vitest"

function workspaceServiceTests() {
  // 1. Root initialization
  it("Initializes with null root", () => {
    const service = createWorkspaceService();
    expect(service.currentRoot()).toBe(null);
  });

  // 2. Valid path inside workspace
  it("Reads valid file", async () => {
    const service = createWorkspaceService({ picker: { pick: () => Promise.resolve({ picked: true, root: "C:\\temp\\workspace" }) } });
    await service.ensureConnected();
    await service.write("test.txt", "content");
    expect(await service.read("test.txt")).toBe("content");
  });

  // 3. Nested path
  it("Handles nested paths", async () => {
    const service = createWorkspaceService({ picker: { pick: () => Promise.resolve({ picked: true, root: "C:\\temp\\workspace" }) } });
    await service.ensureConnected();
    await service.write("dir/sub/file.txt", "nested");
    expect(await service.read("dir/sub/file.txt")).toBe("nested");
  });

  // 4. ..\ traversal
  it("Rejects .. paths", async () => {
    const service = createWorkspaceService({ picker: { pick: () => Promise.resolve({ picked: true, root: "C:\\temp\\workspace" }) } });
    await service.ensureConnected();
    await expect(() => service.read("..\/bad.txt")).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
  });

  // 5. Absolute path
  it("Rejects absolute paths", async () => {
    const service = createWorkspaceService();
    await expect(() => service.read("C:\\temp\\bad.txt")).rejects.toThrow("INVALID_CWD");
  });

  // 6. Drive path
  it("Rejects external drive paths", async () => {
    const service = createWorkspaceService();
    await expect(() => service.read("D:\\another.txt")).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
  });

  // 7. Disconnect
  it("Works after disconnect", async () => {
    const service = createWorkspaceService();
    await service.ensureConnected();
    await service.close();
    await expect(() => service.read("test.txt")).rejects.toThrow("No workspace folder is connected");
  });

  // 8. Invalid path
  it("Rejects invalid paths", async () => {
    const service = createWorkspaceService();
    await expect(() => service.read("invalid.txt")).rejects.toThrow("Path not found");
  });

  // ... (additional tests for remaining requirements)
}

runTests() {
  describe("WorkspaceService", workspaceServiceTests);
}