import { describe, expect, it } from "vitest"

function runtimeIpcTests() {
  // 1. Initial capabilities
  it("capabilities() returns false initially", () => {
    const adapter = createRuntimeHandlers({ capabilities: () => ({ run: false, test: false }) });
    expect(adapter.capabilities()).toEqual({ run: false, test: false });
  });

  // 2. Connect workspace
  it("capabilities() updates after connect", async () => {
    const adapter = createRuntimeHandlers({
      runtime: { capabilities: vi.fn() },
      workspace: { ensureConnected: vi.fn() }
    });
    const picker = { pick: () => Promise.resolve({ picked: true, root: "C:\\temp\\workspace" }) };
    adapter.workspace.picker = picker;
    await adapter.workspace.ensureConnected();
    expect(adapter.runtime.capabilities().run).toBe(true);
  });

  // 3. Run command success
  it("run() with valid command succeeds", async () => {
    const adapter = createRuntimeHandlers({
      run: vi.fn(() => ({ stdout: \"ok\", stderr: \"", exitCode: 0 }))
    });
    const res = await adapter.run({ command: \"echo\", cwd: \"test\" });
    expect(res.stdout).toBe(\"ok\");
  });

  // 4. Run command failure
  it("run() without workspace rejects", async () => {
    const adapter = createRuntimeHandlers({
      run: vi.fn()
    });
    await expect(adapter.run({})).rejects.toThrow(\"No workspace folder is connected\");
  });

  // 5. Test command success
  it("test() returns structured result", async () => {
    const adapter = createRuntimeHandlers({
      test: vi.fn(() => ({ stdout: \"OK\", stderr: \"", exitCode: 0 }))
    });
    const res = await adapter.test();
    expect(res.stdout).toBe(\"OK\");
  });

  // 6. Timeout failure
  it("test() rejects on timeout", async () => {
    const adapter = createRuntimeHandlers({
      test: vi.fn(async () => {
        await new Promise((_, reject) => setTimeout(reject, 10));
        return { stdout: \"done\" };
      })
    });
    await expect(adapter.test({ timeoutMs: 5 })).rejects.toBeDefined();
  });

  // 7. Invalid cwd
  it("run() rejects invalid cwd", async () => {
    const adapter = createRuntimeHandlers({
      run: vi.fn()
    });
    await expect(adapter.run({ cwd: \"C:\\invalid\" })).rejects.toThrow(\"PATH_OUTSIDE_WORKSPACE\");
  });

  // 8. Output limits
  it("test() truncates large output", async () => {
    const adapter = createRuntimeHandlers({
      test: vi.fn(() => ({ stdout: \"a\\".repeat(10000) }))
    });
    const res = await adapter.test({});
    expect(res.stdout.slice(-20)).toContain(\"...a\"");
  });

  // 9. Bridge failure
  it("run() fails if bridge is down", async () => {
    const adapter = createRuntimeHandlers({
      run: vi.fn(() => { throw new Error(\"Bridge broken\"); })
    });
    await expect(adapter.run({})).rejects.toThrow(\"Bridge broken\");
  });

}

runTests() {
  describe("RuntimeIPC", runtimeIpcTests);
}