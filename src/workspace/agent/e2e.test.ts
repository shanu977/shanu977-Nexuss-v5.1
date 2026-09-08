import { describe, it, expect, vi } from "vitest";
import { InMemoryBridge } from "@/workspace/bridge";
import { buildIndex } from "@/workspace/indexer";
import type { ToolContext } from "@/workspace/agent/types";
import { workflowReadProject, workflowCreateFile, workflowEditFile, workflowTerminal, workflowMultiStep } from "@/workspace/agent/orchestrator";
import { toolList, toolRead, toolProposeEdit, toolMkdir } from "@/workspace/agent/tools";

function makeCtx(files: Record<string,string>, withRuntime = false): ToolContext {
  const bridge = new InMemoryBridge("e2e-test", files);
  const list = () => bridge.list().then(s => s.map(f=>({path:f.path,size:f.size,mtime:f.mtime,content:f.content})));
  // build index synchronously for search
  const fakeFiles = Object.entries(files).map(([p,c])=>({path:p,size:c.length,mtime:0,content:c}));
  const index = buildIndex("e2e-test", fakeFiles);
  const runtime = withRuntime ? {
    run: vi.fn(async ({command,cwd}:{command:string,cwd?:string})=>({command,cwd:cwd||"",exitCode:0,stdout:`executed ${command}`,stderr:"",durationMs:10,timedOut:false,killed:false,signal:null,success:true,outputTruncated:false,redacted:false})),
    test: vi.fn(async ()=>({command:"npm test",cwd:"",exitCode:0,stdout:"ok",stderr:"",durationMs:10,timedOut:false,killed:false,signal:null,success:true,outputTruncated:false,redacted:false,plan:{command:"npm test",source:"package.json",confidence:"high"}})),
    capabilities: ()=>({read:true,search:true,write:true,create:true,rename:true,move:true,delete:true,mkdir:true,run:true,test:true}),
    cancel: ()=>{}
  } as unknown as ToolContext["runtime"] : null;
  return { connected:true, bridge, index, runtime };
}

describe("E2E agent workflows (section 18)", () => {
  it("Test 1 — Read: explain structure via fs.list", async ()=>{
    const ctx = makeCtx({"src/a.ts":"export const a=1","README.md":"# hi"});
    const res = await workflowReadProject(ctx);
    expect(res.success).toBe(true);
    expect(res.steps[0].result).toContain("src");
  });

  it("Test 2 — Create: hello.ts", async ()=>{
    const ctx = makeCtx({});
    const res = await workflowCreateFile(ctx, "hello.ts", "export function hello(){return 'hi'}");
    expect(res.success).toBe(true);
    expect(await ctx.bridge!.read("hello.ts")).toContain("hello");
  });

  it("Test 3 — Edit: change hello to return Hello Nexuss", async ()=>{
    const ctx = makeCtx({"hello.ts":"export function hello(){return 'hi'}"});
    const res = await workflowEditFile(ctx, "hello.ts", "return 'hi'", "return 'Hello Nexuss'");
    expect(res.success).toBe(true);
    expect(await ctx.bridge!.read("hello.ts")).toContain("Hello Nexuss");
  });

  it("Test 4 — Terminal: run project test suite", async ()=>{
    const ctx = makeCtx({}, true);
    const res = await workflowTerminal(ctx, "npm test");
    expect(res.success).toBe(true);
    expect(res.steps[0].result).toContain("exit 0");
  });

  it("Test 5 — Error recovery: failing test then fix", async ()=>{
    const ctx = makeCtx({"src/util.ts":"export function hello(){return 'wrong'}"}, false);
    // Try targeted edit with wrong oldText -> should get EDIT_CONFLICT
    await expect(toolProposeEdit(ctx, "src/util.ts", "NOT_PRESENT", "x")).rejects.toMatchObject({code:"EDIT_CONFLICT"});
    // Correct fix
    const fix = await workflowEditFile(ctx, "src/util.ts", "return 'wrong'", "return 'Hello Nexuss'");
    expect(fix.success).toBe(true);
  });

  it("Test 6 — Multi-step coding: create project, run, verify", async ()=>{
    const ctx = makeCtx({}, true);
    const res = await workflowMultiStep(ctx);
    expect(res.success).toBe(true);
    expect(res.steps.length).toBeGreaterThan(4);
    expect(await ctx.bridge!.read("src/util.ts")).toContain("Hello");
  });

  it("fs.list + mkdir + read integration", async ()=>{
    const ctx = makeCtx({"a/b/c.ts":"hi"});
    const listing = await toolList(ctx, "a/b");
    expect(listing.some(r=>r.path==="a/b/c.ts")).toBe(true);
    await toolMkdir(ctx, "newdir/sub");
    const rootList = await toolList(ctx, "");
    expect(rootList.some(r=>r.path==="newdir")).toBe(true);
    const read = await toolRead(ctx, "a/b/c.ts");
    expect(read.content).toBe("hi");
  });
});
