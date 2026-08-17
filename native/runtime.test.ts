// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createNativeRuntime } from "./runtime";
import { makeFixture, nodeScript } from "./test-helpers";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createNativeRuntime", () => {
  it("reports no run/test capability until a workspace is set", () => {
    const rt = createNativeRuntime();
    expect(rt.workspaceRoot).toBeNull();
    expect(rt.capabilities().run).toBe(false);
    expect(rt.capabilities().test).toBe(false);
  });

  it("throws WORKSPACE_NOT_CONNECTED before a workspace exists", async () => {
    const rt = createNativeRuntime();
    await expect(rt.run({ command: "npm test" })).rejects.toMatchObject({
      code: "WORKSPACE_NOT_CONNECTED"
    });
    await expect(rt.test({})).rejects.toMatchObject({
      code: "WORKSPACE_NOT_CONNECTED"
    });
  });

  it("enables capabilities after setWorkspace and runs a real npm test", async () => {
    const fx = makeFixture();
    try {
      fx.write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          scripts: { test: nodeScript("console.log('runtime-ok')") }
        })
      );
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      expect(rt.workspaceRoot).toBe(fx.root);
      expect(rt.capabilities().run).toBe(true);
      expect(rt.capabilities().test).toBe(true);

      const res = await rt.run({ command: "npm test" });
      expect(res.success).toBe(true);
      expect(res.stdout).toContain("runtime-ok");
    } finally {
      fx.cleanup();
    }
  });

  it("discovers and runs the project test plan", async () => {
    const fx = makeFixture();
    try {
      fx.write(
        "package.json",
        JSON.stringify({
          scripts: { test: nodeScript("console.log('planned-ok')") }
        })
      );
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      const res = await rt.test({});
      expect(res.plan).toEqual({
        command: "npm test",
        source: "package.json#scripts.test",
        confidence: "high"
      });
      expect(res.success).toBe(true);
      expect(res.stdout).toContain("planned-ok");
    } finally {
      fx.cleanup();
    }
  });

  it("throws TEST_COMMAND_NOT_FOUND when no test command is configured", async () => {
    const fx = makeFixture();
    try {
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      await expect(rt.test({})).rejects.toMatchObject({
        code: "TEST_COMMAND_NOT_FOUND"
      });
    } finally {
      fx.cleanup();
    }
  });

  it("discovers a plan without executing it", async () => {
    const fx = makeFixture();
    try {
      fx.write("pytest.ini", "[pytest]\n");
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      expect(rt.discoverTest()).toEqual({
        command: "pytest",
        source: "pytest config",
        confidence: "high"
      });
    } finally {
      fx.cleanup();
    }
  });

  it("invalidates the active command when the workspace switches", async () => {
    const fx = makeFixture();
    const fx2 = makeFixture();
    try {
      fx.write(
        "package.json",
        JSON.stringify({
          scripts: { test: nodeScript("setInterval(()=>{},50)") }
        })
      );
      fx2.write("package.json", "{}");
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      const running = rt.run({ command: "npm test", timeoutMs: 60_000 });
      // Give the child time to spawn, then switch workspaces.
      await delay(2000);
      rt.setWorkspace(fx2.root);
      const res = await running;
      expect(res.killed).toBe(true);
      expect(res.success).toBe(false);
    } finally {
      fx.cleanup();
      fx2.cleanup();
    }
  });

  it("cancels the active command via cancel()", async () => {
    const fx = makeFixture();
    try {
      fx.write(
        "package.json",
        JSON.stringify({
          scripts: { test: nodeScript("setInterval(()=>{},50)") }
        })
      );
      const rt = createNativeRuntime();
      rt.setWorkspace(fx.root);
      const running = rt.run({ command: "npm test", timeoutMs: 60_000 });
      await delay(2000);
      rt.cancel();
      const res = await running;
      expect(res.killed).toBe(true);
      expect(res.success).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
