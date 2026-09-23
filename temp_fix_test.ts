import { planFilesystemActions } from "./src/workspace/agent/actionPlanner";
import { pushVerifiedObservation, getRecentExecutionContext, clearExecutionContext } from "./src/workspace/agent/executionContext";
import * as os from "os";
import * as path from "path";

const chatId = "fixTest";
clearExecutionContext(chatId);
// Simulate recent folder/file
pushVerifiedObservation(chatId, {
  userText: "create a folder called kumar999 and write 50 lines of JavaScript code in it",
  command: 'powershell -NoProfile -Command "New-Item -ItemType Directory -Path ""$env:USERPROFILE\\kumar999"" -Force"',
  cwd: os.homedir(),
  stdout: path.join(os.homedir(), "kumar999"),
  stderr: "",
  exitCode: 0,
  success: true,
  action: "create" as any,
  object: "folder" as any,
  name: "kumar999",
  path: path.join(os.homedir(), "kumar999")
} as any);
pushVerifiedObservation(chatId, {
  userText: "create a folder called kumar999 and write 50 lines of JavaScript code in it",
  command: 'powershell -NoProfile -Command "[Convert]::FromBase64String(\'abc\') | Set-Content -LiteralPath ""$env:USERPROFILE\\kumar999\\index.js"" -Encoding Byte"',
  cwd: os.homedir(),
  stdout: "",
  stderr: "",
  exitCode: 0,
  success: true,
  action: "create" as any,
  object: "file" as any,
  name: "index.js",
  path: path.join(os.homedir(), "kumar999", "index.js")
} as any);

console.log("Recent context:", getRecentExecutionContext(chatId));

const actions = planFilesystemActions("find the bug and fix it", chatId);
console.log(JSON.stringify(actions, null, 2));
