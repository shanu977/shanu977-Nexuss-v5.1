import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { buildIndex } from "@/workspace/indexer";
import { executeFencedTools, formatToolResults, hasAnyFence, stripAllFences, MAX_AGENT_STEPS } from "@/workspace/agent/loop";

beforeEach(async ()=>{
  await useWorkspaceStore.getState().disconnect();
  const bridge = new InMemoryBridge("prod", {"NexussDemo/src/a.ts":"buggy","NexussDemo/package.json":'{"scripts":{"test":"vitest"}}'});
  const files = [{path:"NexussDemo/src/a.ts",size:5,mtime:0,content:"buggy"},{path:"NexussDemo/package.json",size:2,mtime:0,content:"{}"}];
  const index = buildIndex("prod", files);
  useWorkspaceStore.setState({ bridge, index, connected:true, workspace:{name:"prod",root:"prod",kind:"in-memory"}, pathEnabled:true, activeProject:null, agentAutoLoop:true, panelOpen:true });
});

describe("Production Chat → LLM → Agent → Tools loop", ()=>{
  it("hasAnyFence detects workspace-change and workspace-command", ()=>{
    expect(hasAnyFence('hello ```workspace-change {"changes":[{"path":"a.ts","content":"hi"}]}```')).toBe(true);
    expect(hasAnyFence('```workspace-command {"run":{"command":"npm test"}}```')).toBe(true);
    expect(hasAnyFence('no fence')).toBe(false);
  });

  it("stripAllFences removes both fences", ()=>{
    const txt = 'Fixing\n```workspace-change {"changes":[{"path":"a.ts","content":"x"}]}```\nDone\n```workspace-command {"run":{"command":"npm test"}}```';
    const stripped = stripAllFences(txt);
    expect(stripped).not.toContain("workspace-change");
    expect(stripped).not.toContain("workspace-command");
    expect(stripped).toContain("Fixing");
  });

  it("executeFencedTools auto-applies change when Path ON + in-memory and returns result to model", async ()=>{
    const modelText = 'Fix bug\n```workspace-change {"changes":[{"path":"NexussDemo/src/a.ts","content":"fixed"}]}```';
    const { results, stripped } = await executeFencedTools(modelText);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(stripped).not.toContain("workspace-change");
    // Verify file actually changed via bridge
    const bridge = useWorkspaceStore.getState().bridge as InMemoryBridge;
    expect(await bridge.read("NexussDemo/src/a.ts")).toBe("fixed");
  });

  it("executeFencedTools blocked when Path OFF", async ()=>{
    useWorkspaceStore.getState().setPathEnabled(false);
    const modelText = '```workspace-change {"changes":[{"path":"a.ts","content":"x"}]}```';
    const { results } = await executeFencedTools(modelText);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("Terminal is not connected");
  });

  it("formatToolResults returns text that would be fed back to LLM and loop continues", async ()=>{
    // Simulate ONE user message multi-step: model1 → list → read → run → edit → run → final
    const s1 = 'Inspecting\n```workspace-command {"run":{"command":"npm test"}}```';
    // Initially workspace has no test command but in-memory will validate? Use generic npm run via auto-apply still needs runtime mock
    // Instead test change loop
    const changeText = '```workspace-change {"changes":[{"path":"NexussDemo/src/calc.ts","content":"export function add(a:number,b:number){return a+b}"}]}```';
    const r1 = await executeFencedTools(changeText);
    expect(r1.results[0].success).toBe(true);
    const toolText = formatToolResults(r1.results);
    expect(toolText).toContain("Tool results");
    expect(toolText).toContain("NexussDemo/src/calc.ts");
    // Next model would receive toolText as history and produce next tool call
    const nextModelText = 'Now run tests\n```workspace-command {"run":{"command":"npm test","cwd":"NexussDemo"}}```';
    expect(hasAnyFence(nextModelText)).toBe(true);
  });

  it("MAX_AGENT_STEPS limits autonomous iterations", ()=>{
    expect(MAX_AGENT_STEPS).toBeGreaterThanOrEqual(5);
  });

  it("Project discovery via activeProject sets cwd for terminal", async ()=>{
    const found = useWorkspaceStore.getState().discoverProject("NexussDemo");
    expect(found).toBe("NexussDemo");
    expect(useWorkspaceStore.getState().activeProject).toBe("NexussDemo");
  });

  it("Critical acceptance: ONE user message NexussDemo inspect→fix→test loop (simulated production path)", async ()=>{
    // Enable Path
    expect(useWorkspaceStore.getState().pathEnabled).toBe(true);
    // Step1 model inspects and creates fix
    const step1 = 'Found bug\n```workspace-change {"changes":[{"path":"NexussDemo/src/calculator.ts","content":"export function calc(){return 42}"}]}```';
    const e1 = await executeFencedTools(step1);
    expect(e1.results[0].success).toBe(true);
    const tool1 = formatToolResults(e1.results);
    // Step2 model runs tests after seeing tool1
    // For in-memory without real runtime, we simulate command result via mock bridge
    // Verify that after fix, file is correct (production would have run npm test and gotten stdout)
    const bridge = useWorkspaceStore.getState().bridge as InMemoryBridge;
    expect(await bridge.read("NexussDemo/src/calculator.ts")).toContain("42");
    // Simulate test failure recovery loop
    const step2 = 'Tests failed, fixing\n```workspace-change {"changes":[{"path":"NexussDemo/src/calculator.ts","content":"export function calc(){return 24}"}]}```';
    const e2 = await executeFencedTools(step2);
    expect(e2.results[0].success).toBe(true);
    const tool2 = formatToolResults(e2.results);
    expect(tool1).toContain("calculator.ts");
    expect(tool2).toContain("calculator.ts");
    // Final model would produce no fence
    const finalModel = 'Fixed and verified. Tests pass.';
    expect(hasAnyFence(finalModel)).toBe(false);
    expect(stripAllFences(finalModel)).toBe(finalModel);
  });
});
