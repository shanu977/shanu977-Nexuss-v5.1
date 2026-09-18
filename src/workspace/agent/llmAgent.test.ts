import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createAgentPlan, planViaDeterministic } from "./llmPlanner";
import { validateAgentPlan } from "./planValidator";
import { buildAgentContext } from "./agentContext";
import { clearAgentState } from "./agentState";
import { clearExecutionContext, pushExecutionContext } from "./executionContext";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";

// Helper to mock Ollama response
function mockOllamaResponse(json: any) {
  const content = JSON.stringify(json);
  vi.stubGlobal("fetch", vi.fn(async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("127.0.0.1:11434") || urlStr.includes("localhost:11434")) {
      return new Response(JSON.stringify({ message: { content }, done: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // For other fetches (like connector health), return ok
    return new Response(JSON.stringify({ status: "ok", connector: "nexuss-local" }), { status: 200 });
  }));
}

describe("LLM Agent - Natural Language Variations", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("test-chat");
    clearExecutionContext("test-chat");
    vi.unstubAllGlobals();
    // Ensure not in test env skip? We want to test LLM path, so we need to not be in test env skip
    // Temporarily set NODE_ENV to development to allow LLM call
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });

  const variations = [
    "create a folder called test",
    "make a test directory",
    "I need a new test folder",
    "set up a test folder",
    "can you make me a directory called test?",
    "give me a place called test to store these files",
    "mkdir test",
    "make a folder named test",
    "create directory test",
  ];

  for (const phrase of variations) {
    it(`understands variation: "${phrase}"`, async () => {
      mockOllamaResponse({
        intent: "create_directory",
        explanation: "Create test folder",
        actions: [{ type: "createDirectory", path: "test" }]
      });
      const { plan, via } = await createAgentPlan(phrase, "test-chat");
      expect(via).toBe("llm");
      expect(plan.intent).toBe("create_directory");
      expect(plan.actions[0].type).toBe("createDirectory");
      expect((plan.actions[0] as any).path).toBe("test");
      expect(validateAgentPlan(plan).valid).toBe(true);
    });
  }
});

describe("LLM Agent - Context Resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("test-chat");
    clearExecutionContext("test-chat");
    useWorkspaceStore.setState({ workspacePath: "C:\\workspace\\project", workspace: { name: "project", root: "C:\\workspace\\project", kind: "fs-access" } as any });
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });

  it("resolves same name in Downloads", async () => {
    // Simulate previous creation of kumar19
    pushExecutionContext("test-chat", {
      userText: "Create a folder called kumar19",
      command: "powershell New-Item -Path 'C:\\workspace\\project\\kumar19'",
      cwd: "C:\\workspace\\project",
      stdout: "C:\\workspace\\project\\kumar19",
      stderr: "",
      exitCode: 0,
      success: true,
      action: "create",
      object: "folder",
      name: "kumar19",
      path: "C:\\workspace\\project\\kumar19",
      verified: true
    });
    mockOllamaResponse({
      intent: "create_directory",
      explanation: "Create kumar19 in Downloads",
      actions: [{ type: "createDirectory", path: "C:\\Users\\pilli\\Downloads\\kumar19" }]
    });
    const { plan } = await createAgentPlan("Create the same name folder in Downloads.", "test-chat");
    expect(plan.actions[0].type).toBe("createDirectory");
    expect((plan.actions[0] as any).path).toBe("C:\\Users\\pilli\\Downloads\\kumar19");
  });

  it("resolves 'Move it there' with context", async () => {
    pushExecutionContext("test-chat", {
      userText: "Create report.txt",
      command: "New-Item -Path 'report.txt'",
      cwd: "C:\\workspace",
      stdout: "C:\\workspace\\report.txt",
      stderr: "",
      exitCode: 0,
      success: true,
      action: "create",
      object: "file",
      name: "report.txt",
      path: "C:\\workspace\\report.txt",
      verified: true
    });
    // Add folder context
    pushExecutionContext("test-chat", {
      userText: "Create reports folder",
      command: "New-Item -Path 'reports'",
      cwd: "C:\\workspace",
      stdout: "C:\\workspace\\reports",
      stderr: "",
      exitCode: 0,
      success: true,
      action: "create",
      object: "folder",
      name: "reports",
      path: "C:\\workspace\\reports",
      verified: true
    });
    mockOllamaResponse({
      intent: "move",
      explanation: "Move report.txt into reports",
      actions: [{ type: "move", source: "report.txt", destination: "reports/report.txt" }]
    });
    const { plan } = await createAgentPlan("Move it into the reports folder.", "test-chat");
    expect(plan.actions[0].type).toBe("move");
    expect((plan.actions[0] as any).source).toBe("report.txt");
    expect((plan.actions[0] as any).destination).toBe("reports/report.txt");
  });
});

describe("LLM Agent - Absolute vs Relative", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });
  it("preserves absolute path C:\\Users\\pilli\\Downloads\\kumar19", async () => {
    mockOllamaResponse({
      intent: "create_directory",
      explanation: "Create kumar19 in Downloads",
      actions: [{ type: "createDirectory", path: "C:\\Users\\pilli\\Downloads\\kumar19" }]
    });
    const { plan } = await createAgentPlan("Create a folder called kumar19 at C:\\Users\\pilli\\Downloads", "test-chat");
    expect((plan.actions[0] as any).path).toBe("C:\\Users\\pilli\\Downloads\\kumar19");
    expect(validateAgentPlan(plan, "C:\\workspace").valid).toBe(true);
    // Ensure not rewritten to workspace
    expect((plan.actions[0] as any).path).not.toContain("shanu977-Nexuss-v5.1");
  });

  it("handles relative Downloads correctly", async () => {
    mockOllamaResponse({
      intent: "create_directory",
      explanation: "Create test in Downloads relative",
      actions: [{ type: "createDirectory", path: "Downloads/test" }]
    });
    const { plan } = await createAgentPlan("Create test in Downloads", "test-chat");
    expect((plan.actions[0] as any).path).toBe("Downloads/test");
  });
});

describe("LLM Agent - Ambiguity", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    localStorage.clear();
    clearExecutionContext("test-chat");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });
  it("asks clarification when ambiguous", async () => {
    mockOllamaResponse({
      intent: "clarification",
      explanation: "Could you clarify which folder you mean?",
      actions: []
    });
    const { plan } = await createAgentPlan("Create another one there.", "test-chat");
    expect(plan.intent).toBe("clarification");
    expect(plan.actions.length).toBe(0);
    const v = validateAgentPlan(plan);
    expect(v.valid).toBe(true); // clarification with 0 actions is valid
  });
});

describe("LLM Agent - Security", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });
  it("blocks traversal ../evil", async () => {
    mockOllamaResponse({
      intent: "create_directory",
      explanation: "Try evil",
      actions: [{ type: "createDirectory", path: "../evil" }]
    });
    const { plan } = await createAgentPlan("Create a folder named ../evil", "test-chat");
    const v = validateAgentPlan(plan);
    expect(v.valid).toBe(false);
    expect((v as any).code).toBe("SECURITY");
  });
  it("blocks absolute traversal C:\\..\\evil", async () => {
    mockOllamaResponse({
      intent: "create_directory",
      explanation: "Try evil",
      actions: [{ type: "createDirectory", path: "C:\\Users\\pilli\\..\\evil" }]
    });
    const { plan } = await createAgentPlan("Create folder at C:\\Users\\pilli\\..\\evil", "test-chat");
    const v = validateAgentPlan(plan);
    expect(v.valid).toBe(false);
  });
});

describe("Deterministic Fallback - still works when LLM unavailable", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("test-chat");
    clearExecutionContext("test-chat");
    // Ensure LLM fails -> fallback
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network error"); }));
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "test");
  });
  it("fallback creates folder for simple request", async () => {
    const { plan, via } = await createAgentPlan("Create a folder called test", "test-chat");
    expect(via).toBe("deterministic");
    expect(plan.actions.length).toBeGreaterThan(0);
  });
});
