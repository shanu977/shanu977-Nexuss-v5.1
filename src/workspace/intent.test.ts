import { describe, expect, it } from "vitest";
import { classifyWorkspaceIntent } from "@/workspace/intent";

describe("classifyWorkspaceIntent", () => {
  it("classifies status questions", () => {
    expect(classifyWorkspaceIntent("Can you see my folder?")).toBe("status");
    expect(classifyWorkspaceIntent("Can you access my project?")).toBe("status");
    expect(classifyWorkspaceIntent("Are you able to read my workspace?")).toBe("status");
    expect(classifyWorkspaceIntent("Did you get my folder?")).toBe("status");
    expect(classifyWorkspaceIntent("Is my workspace connected?")).toBe("status");
    expect(classifyWorkspaceIntent("Can you see the folder I shared?")).toBe("status");
  });

  it("classifies manifest questions", () => {
    expect(classifyWorkspaceIntent("List my files.")).toBe("manifest");
    expect(classifyWorkspaceIntent("What files are in my project?")).toBe("manifest");
    expect(classifyWorkspaceIntent("Show me the project structure.")).toBe("manifest");
    expect(classifyWorkspaceIntent("What's in the folder?")).toBe("manifest");
    expect(classifyWorkspaceIntent("Which files do I have?")).toBe("manifest");
    expect(classifyWorkspaceIntent("What do you see in my repo?")).toBe("manifest");
  });

  it("classifies summary questions", () => {
    expect(classifyWorkspaceIntent("What is this project?")).toBe("summary");
    expect(classifyWorkspaceIntent("Tell me about this workspace.")).toBe("summary");
    expect(classifyWorkspaceIntent("Summarize the project.")).toBe("summary");
    expect(classifyWorkspaceIntent("Give me an overview of this folder.")).toBe("summary");
  });

  it("leaves ordinary code questions to retrieval", () => {
    expect(classifyWorkspaceIntent("Where is the login code?")).toBe("none");
    expect(classifyWorkspaceIntent("Find the authentication files.")).toBe("none");
    expect(classifyWorkspaceIntent("Show me my package.json")).toBe("none");
    expect(classifyWorkspaceIntent("Why does login.ts reject valid users?")).toBe("none");
    expect(classifyWorkspaceIntent("")).toBe("none");
    expect(classifyWorkspaceIntent("   ")).toBe("none");
  });
});