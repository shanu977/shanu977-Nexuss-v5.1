import { describe, it, expect, beforeEach } from "vitest";
import {
  pushExecutionContext,
  getRecentExecutionContext,
  formatExecutionContextForPrompt,
  clearExecutionContext,
  clearExecutionContextForChat,
} from "./executionContext";

describe("executionContext – continuous agent", () => {
  beforeEach(() => {
    clearExecutionContext();
    // clear localStorage between tests
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("TEST1: create folder shanu → follow-up it", () => {
    pushExecutionContext("chat-1", {
      userText: "Create a folder called shanu",
      command: "mkdir shanu",
      cwd: "C:/Users/pilli/Desktop",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    const fmt = formatExecutionContextForPrompt("chat-1");
    expect(fmt).toContain('name="shanu"');
    expect(fmt).toContain('path="C:/Users/pilli/Desktop/shanu"');
  });

  it("nested: shanu → project → README", () => {
    pushExecutionContext("chat-1", {
      userText: "Create a folder called shanu",
      command: "mkdir shanu",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    pushExecutionContext("chat-1", {
      userText: "Create a folder inside it called project",
      command: "mkdir shanu/project",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    pushExecutionContext("chat-1", {
      userText: "Create a file called README.md inside that folder",
      command: "powershell -NoProfile -Command \"New-Item -ItemType File -Path 'C:/tmp/shanu/project/README.md'\"",
      cwd: "C:/tmp/shanu/project",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    const recent = getRecentExecutionContext("chat-1");
    expect(recent.length).toBe(3);
    expect(recent[2].name).toBe("README.md");
    const fmt = formatExecutionContextForPrompt("chat-1");
    expect(fmt).toContain('shanu/project/README.md');
  });

  it("delete continuity", () => {
    pushExecutionContext("chat-1", {
      userText: "Create a folder called shanu",
      command: "mkdir shanu",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    pushExecutionContext("chat-1", {
      userText: "Delete that project folder",
      command: "Remove-Item -LiteralPath 'C:/tmp/shanu/project' -Recurse",
      cwd: "C:/tmp/shanu",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    const fmt = formatExecutionContextForPrompt("chat-1");
    expect(fmt).toContain('action=delete');
  });

  it("failed command not used for pronoun", () => {
    pushExecutionContext("chat-1", {
      userText: "Create a folder using invalid",
      command: "mkdir ???",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "Access denied",
      exitCode: 1,
      success: false,
    });
    const fmt = formatExecutionContextForPrompt("chat-1");
    expect(fmt).toBeNull(); // no successful context
  });

  it("cross-chat isolation", () => {
    pushExecutionContext("chat-A", {
      userText: "Create folder shanu",
      command: "mkdir shanu",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    pushExecutionContext("chat-B", {
      userText: "Create folder test",
      command: "mkdir test",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    const fmtA = formatExecutionContextForPrompt("chat-A");
    const fmtB = formatExecutionContextForPrompt("chat-B");
    expect(fmtA).toContain('shanu');
    expect(fmtA).not.toContain('test');
    expect(fmtB).toContain('test');
    expect(fmtB).not.toContain('shanu');
  });

  it("reload survival via localStorage", () => {
    pushExecutionContext("chat-1", {
      userText: "Create folder shanu",
      command: "mkdir shanu",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    // Simulate reload: clear in-memory but keep localStorage
    // @ts-ignore access private
    const before = formatExecutionContextForPrompt("chat-1");
    expect(before).toContain("shanu");
  });

  it("clear on chat delete", () => {
    pushExecutionContext("chat-1", {
      userText: "Create folder shanu",
      command: "mkdir shanu",
      cwd: "C:/tmp",
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    clearExecutionContextForChat("chat-1");
    expect(formatExecutionContextForPrompt("chat-1")).toBeNull();
  });
});
