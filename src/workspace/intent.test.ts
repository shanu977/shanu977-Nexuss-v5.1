import { describe, expect, it } from "vitest";
import { classifyWorkspaceIntent } from "@/workspace/intent";
import { isFilesystemActionRequest, planFilesystemActions } from "@/workspace/agent/actionPlanner";

describe("classifyWorkspaceIntent", () => {
  it("classifies status questions", () => {
    expect(classifyWorkspaceIntent("Can you see my folder?")).toBe("status");
    expect(classifyWorkspaceIntent("Can you access my project?")).toBe("status");
    expect(classifyWorkspaceIntent("Are you able to read my workspace?")).toBe("status");
    expect(classifyWorkspaceIntent("Did you get my folder?")).toBe("status");
    expect(classifyWorkspaceIntent("Is my workspace connected?")).toBe("status");
    expect(classifyWorkspaceIntent("Can you see the folder I shared?")).toBe("status");
    expect(classifyWorkspaceIntent("What was the folder name?")).toBe("status");
    expect(classifyWorkspaceIntent("What folder did I connect?")).toBe("status");
    expect(classifyWorkspaceIntent("What is my project called?")).toBe("status");
    expect(classifyWorkspaceIntent("How many files do you have?")).toBe("status");
    expect(classifyWorkspaceIntent("Is my project connected?")).toBe("status");
  });

  it("classifies manifest questions", () => {
    expect(classifyWorkspaceIntent("List my files.")).toBe("manifest");
    expect(classifyWorkspaceIntent("What files are in my project?")).toBe("manifest");
    expect(classifyWorkspaceIntent("Show me the project structure.")).toBe("manifest");
    expect(classifyWorkspaceIntent("What's in the folder?")).toBe("manifest");
    expect(classifyWorkspaceIntent("Which files do I have?")).toBe("manifest");
    expect(classifyWorkspaceIntent("What do you see in my repo?")).toBe("manifest");
    expect(classifyWorkspaceIntent("What folders are there?")).toBe("manifest");
    expect(classifyWorkspaceIntent("What directories exist?")).toBe("manifest");
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

  it("keeps path questions as normal conversation", () => {
    expect(isFilesystemActionRequest("What is the path?")).toBe(false);
    expect(isFilesystemActionRequest("Where is this?")).toBe(false);
    expect(isFilesystemActionRequest("Tell me the path")).toBe(false);
  });

  it("detects explicit terminal work", () => {
    expect(isFilesystemActionRequest("create a folder")).toBe(true);
    expect(isFilesystemActionRequest("create a file")).toBe(true);
    expect(isFilesystemActionRequest("run npm install")).toBe(true);
    expect(isFilesystemActionRequest("modify this code")).toBe(true);
  });

  it("keeps all steps in a folder-plus-page request", () => {
    const actions = planFilesystemActions(
      "Create a new folder called portal-project and create a basic login page inside it.",
      "intent-test"
    );
    expect(actions.map((action) => action.kind)).toEqual([
      "createFolder",
      "createFile"
    ]);
    expect(actions[1]).toMatchObject({
      kind: "createFile",
      name: "login.html",
      folderRef: "it"
    });
  });
});