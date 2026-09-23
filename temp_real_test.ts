import { planFilesystemActions, getIncompleteClarification } from "./src/workspace/agent/actionPlanner";
import { resolveIntent } from "./src/workspace/agent/intent";

console.log("TEST folder parsing");
const folder = (planFilesystemActions as any)("create a folder name called kumar999 and write a code in that any code have to 50 lines this is a test so make it", "testChat");
console.log(JSON.stringify(folder, null, 2));
console.log("folder name:", folder[0]?.name === "kumar999" ? "PASS kumar999" : "FAIL " + folder[0]?.name);

console.log("\nTEST incomplete:", getIncompleteClarification("create a folder"));
console.log("\nTEST intent powerShell:", resolveIntent("what is a PowerShell terminal?"));

console.log("\nTEST compound JS:");
const comp = planFilesystemActions("create a folder called kumar999 and write 50 lines of JavaScript code in it", "testChat2");
console.log(JSON.stringify(comp, null, 2));
console.log("Has folder:", comp.some(c=>c.kind==="createFolder"));
console.log("Has file:", comp.some(c=>c.kind==="createFile"));
console.log("Has run:", comp.some(c=>c.kind==="run"));
if (comp.length>0) {
  const file = comp.find(c=>c.kind==="createFile") as any;
  console.log("File name:", file?.name, "should be index.js");
  console.log("Content lines:", file?.content ? file.content.split("\n").length : 0);
}
