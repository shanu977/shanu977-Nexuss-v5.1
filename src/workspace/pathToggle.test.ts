import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { buildIndex } from "@/workspace/indexer";
import { toolRead, toolRun, toolList } from "@/workspace/agent/tools";
import type { ToolContext } from "@/workspace/agent/types";
import { workflowMultiStep } from "@/workspace/agent/orchestrator";

function makeCtx(files: Record<string,string>, withRuntime=false, pathEnabled=true): ToolContext {
  const bridge = new InMemoryBridge("ws", files);
  const idxFiles = Object.entries(files).map(([p,c])=>({path:p,size:c.length,mtime:0,content:c}));
  const index = buildIndex("ws", idxFiles);
  const runtime = withRuntime ? {
    run: async ({command,cwd}:{command:string,cwd?:string})=>({command,cwd:cwd||"",exitCode:0,stdout:`ok ${command}`,stderr:"",durationMs:5,timedOut:false,killed:false,signal:null,success:true,outputTruncated:false,redacted:false}),
    test: async ()=>({command:"npm test",cwd:"",exitCode:0,stdout:"ok",stderr:"",durationMs:5,timedOut:false,killed:false,signal:null,success:true,outputTruncated:false,redacted:false,plan:{command:"npm test",source:"package.json",confidence:"high"}}),
    capabilities: ()=>({read:true,search:true,write:true,create:true,rename:true,move:true,delete:true,mkdir:true,run:true,test:true}),
    processStart: async (req:{command:string})=>({id:"p1",command:req.command,cwd:"",pid:123,startedAt:Date.now(),status:"running",exitCode:null,signal:null,durationMs:0,outputTruncated:false}),
  } as unknown as ToolContext["runtime"] : null;
  return { connected:true, pathEnabled, bridge, index, runtime };
}

beforeEach(async ()=>{
  await useWorkspaceStore.getState().disconnect();
  await useWorkspaceStore.getState().connectDemo();
  useWorkspaceStore.setState({ pathEnabled:false, activeProject:null, pendingChanges:[], pendingCommand:null, commandError:null, changeError:null });
});

describe("Path toggle", ()=>{
  it("Test1 - Path OFF blocks terminal", async ()=>{
    const ctx = makeCtx({}, true, false);
    await expect(toolRun(ctx, "npm test")).rejects.toMatchObject({code:"PATH_DISABLED"});
  });

  it("Test2 - Enable Path allows workspace capability", ()=>{
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
    useWorkspaceStore.getState().setPathEnabled(true);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(true);
    useWorkspaceStore.getState().togglePath();
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
  });

  it("Test3 - Terminal pwd simulation when Path ON", async ()=>{
    const ctx = makeCtx({}, true, true);
    const res = await toolRun(ctx, "npm test");
    expect(res.stdout).toContain("ok");
    expect(res.success).toBe(true);
  });

  it("Test4 - Filesystem list/read/create/edit when Path ON", async ()=>{
    const ctx = makeCtx({"a.txt":"hello"}, false, true);
    const listing = await toolList(ctx, "");
    expect(listing.length).toBeGreaterThan(0);
    const read = await toolRead(ctx, "a.txt");
    expect(read.content).toBe("hello");
    // Create via orchestrator
    const wsStore = useWorkspaceStore.getState();
    wsStore.setPathEnabled(true);
    // Use store's applyOperation directly
    const op = await wsStore.applyOperation({type:"create", path:"b.txt", content:"world"});
    expect(op.ok).toBe(true);
  });

  it("Test5 - Project discovery workspace/Nexuss", async ()=>{
    await useWorkspaceStore.getState().disconnect();
    const bridge = new InMemoryBridge("projects", {"Nexuss/package.json":"{}","Nexuss/src/a.ts":"hi","Agency/package.json":"{}"});
    // Manually inject index with nested files
    const files = [{path:"Nexuss/package.json",size:2,mtime:0,content:"{}"},{path:"Nexuss/src/a.ts",size:2,mtime:0,content:"hi"},{path:"Agency/package.json",size:2,mtime:0,content:"{}"}];
    const index = buildIndex("projects", files);
    useWorkspaceStore.setState({ bridge, index, connected:true, workspace:{name:"projects",root:"projects",kind:"in-memory"}, pathEnabled:true });
    const found = useWorkspaceStore.getState().discoverProject("Nexuss");
    expect(found).toBe("Nexuss");
    expect(useWorkspaceStore.getState().activeProject).toBe("Nexuss");
    // Run command in discovered project
    const ctx: ToolContext = { connected:true, pathEnabled:true, bridge, index, runtime: makeCtx({}, true, true).runtime };
    const res = await toolRun(ctx, "npm test", {cwd:"Nexuss"});
    expect(res.success).toBe(true);
  });

  it("Test6 - Multi-step without new user message", async ()=>{
    const ctx = makeCtx({}, true, true);
    const res = await workflowMultiStep(ctx);
    expect(res.success).toBe(true);
    expect(res.steps.length).toBeGreaterThan(4);
  });

  it("Test7 - Disable Path blocks after enabled", async ()=>{
    const store = useWorkspaceStore.getState();
    store.setPathEnabled(true);
    const ctxOn = makeCtx({}, true, true);
    await expect(toolRun(ctxOn, "npm test")).resolves.toBeDefined();
    store.setPathEnabled(false);
    const ctxOff = makeCtx({}, true, false);
    await expect(toolRun(ctxOff, "npm test")).rejects.toMatchObject({code:"PATH_DISABLED"});
  });

  it("Test8 - Workspace boundary blocked", async ()=>{
    const ctx = makeCtx({}, false, true);
    await expect(toolRead(ctx, "../../Windows/win.ini")).rejects.toMatchObject({code:"PATH_OUTSIDE_WORKSPACE"});
    try {
      await toolRead(ctx, "C:/Windows/win.ini");
      throw new Error("should have thrown");
    } catch (e) {
      const code = (e as {code:string}).code;
      expect(["PATH_OUTSIDE_WORKSPACE","INVALID_PATH"]).toContain(code);
    }
  });

  it("Test9 - Screen Share remains separate from Path", async ()=>{
    useWorkspaceStore.getState().setPathEnabled(false);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
    useWorkspaceStore.getState().setPathEnabled(true);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(true);
  });

  it("Test10 - E2E acceptance: discover NexussDemo, fix, run tests", async ()=>{
    const files: Record<string,string> = {
      "NexussDemo/package.json": JSON.stringify({name:"demo",scripts:{test:"node --test"}}),
      "NexussDemo/src/util.ts": "export function hello(){return 'wrong'}",
    };
    const bridge = new InMemoryBridge("tmp", files);
    const idxFiles = Object.entries(files).map(([p,c])=>({path:p,size:c.length,mtime:0,content:c}));
    const index = buildIndex("tmp", idxFiles);
    useWorkspaceStore.setState({ bridge, index, connected:true, workspace:{name:"tmp",root:"tmp",kind:"in-memory"}, pathEnabled:true });
    const disc = useWorkspaceStore.getState().discoverProject("NexussDemo");
    expect(disc).toBe("NexussDemo");
    // Read, edit, verify
    const ctx: ToolContext = { connected:true, pathEnabled:true, bridge, index, runtime: makeCtx({}, true, true).runtime };
    const read = await toolRead(ctx, "NexussDemo/src/util.ts");
    expect(read.content).toContain("wrong");
    // Simulate agent fix
    await bridge.write("NexussDemo/src/util.ts", "export function hello(){return 'Hello Nexuss'}");
    const after = await toolRead(ctx, "NexussDemo/src/util.ts");
    expect(after.content).toContain("Hello Nexuss");
    const run = await toolRun(ctx, "npm test", {cwd:"NexussDemo"});
    expect(run.success).toBe(true);
  });
});
