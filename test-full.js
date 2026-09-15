// Test the exact extractFolderName function
function extractFolderName(clause) {
    const mAs = clause.match(/name\s+it\s+as\s+["']?([a-zA-Z0-9_\- ]+)["']?/i);
    if (mAs) return mAs[1].trim().replace(/\s+/g, " ").trim().replace(/["'`]/g, "");
    const mNamed = clause.match(/\bnamed\s+["']?([a-zA-Z0-9_\- ]+)["']?/i);
    if (mNamed) {
        const raw = mNamed[1].trim().replace(/["'`]/g, "");
        const cut = raw.split(/\s+in\s+this\s+path/i)[0].trim();
        if (cut) return cut.replace(/\s+/g, " ").trim();
    }
    const m = clause.match(/(?:folder|directory|project)\s+(?:called\s+|named\s+|name\s+called\s+)?["']?([a-zA-Z0-9_\- ]+?)["']?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
    if (m) {
        const raw = m[1].trim().replace(/["'`]/g, "");
        if (raw) {
            const cleaned = raw.replace(/\s+/g, " ").trim();
            if (cleaned && cleaned.toLowerCase() !== "in this path name it as raju" && !cleaned.toLowerCase().startsWith("in this path")) return cleaned;
            const fallback = clause.match(/name\s+it\s+as\s+([a-zA-Z0-9_\-]+)/i);
            if (fallback) return fallback[1].trim();
            return cleaned;
        }
    }
    const m2 = clause.match(/called\s+["']?([a-zA-Z0-9_\- ]+)["']?/i);
    if (m2) return m2[1].trim().replace(/\s+/g, " ").trim().replace(/["'`]/g, "");
    return null;
}

function extractAbsolutePath(text) {
    const m = text.match(/([a-zA-Z]:\\[^\s"'`,;]+)/);
    if (m) return m[1].replace(/[.,;]+$/, "").trim();
    const m2 = text.match(/([a-zA-Z]:\/[^\s"'`,;]+)/);
    if (m2) return m2[1].replace(/[.,;]+$/, "").trim();
    return null;
}

function hasExplicitTarget(text) {
    if (/(?:called|named|name\s+it\s+as|name\s+as)\s+["']?[a-zA-Z0-9_\-]+/i.test(text)) return true;
    if (/[a-zA-Z]:[\\/]/.test(text)) return true;
    if (/(create|make)\b.*\.[a-z0-9]{1,4}\b/i.test(text)) return true;
    return false;
}

function synthesizeCreateFolder(name, basePath) {
    const safe = name.replace(/["'`$]/g, "");
    if (basePath) {
        const cleanBase = basePath.replace(/["'`$]/g, "").replace(/\\/g, "\\");
        const normalizedBase = cleanBase.replace(/[\\/]+$/, "");
        const full = normalizedBase + "\\" + safe;
        const safeFull = full.replace(/"/g, "");
        return "powershell -NoProfile -Command \"New-Item -ItemType Directory -Path '" + safeFull + "' -Force | Select-Object -ExpandProperty FullName\"";
    }
    return "powershell -NoProfile -Command \"New-Item -ItemType Directory -Path '.\\" + safe + "' -Force | Select-Object -ExpandProperty FullName\"";
}

// Test 1: create a folder called shanu 1999
const test1 = "create a folder called shanu 1999";
const name1 = extractFolderName(test1);
const cmd1 = synthesizeCreateFolder(name1, null);
console.log("Test 1 - name:", name1);
console.log("Test 1 - cmd:", cmd1);
const m1 = cmd1.match(/-Path '([^']+)'/);
console.log("Test 1 - extracted path:", m1 ? m1[1] : "null");
console.log("Test 1 PASS:", name1 === "shanu 1999" && m1 && m1[1].includes("shanu 1999"));

// Test 2: create a folder called raju
const test2 = "create a folder called raju";
const name2 = extractFolderName(test2);
const cmd2 = synthesizeCreateFolder(name2, null);
console.log("\nTest 2 - name:", name2);
console.log("Test 2 - cmd:", cmd2);
const m2 = cmd2.match(/-Path '([^']+)'/);
console.log("Test 2 PASS:", name2 === "raju" && m2 && m2[1].includes("raju"));

// Test 3: C:\Users\pilli\Downloads create a folder in this path name it as raju
const test3 = "C:\\Users\\pilli\\Downloads create a folder in this path name it as raju";
const name3 = extractFolderName(test3);
const base3 = extractAbsolutePath(test3);
const hasExplicit3 = hasExplicitTarget(test3);
const cmd3 = synthesizeCreateFolder(name3, base3);
console.log("\nTest 3 - name:", name3, "basePath:", base3, "hasExplicit:", hasExplicit3);
console.log("Test 3 - cmd:", cmd3);
const m3 = cmd3.match(/-Path '([^']+)'/);
console.log("Test 3 - extracted path:", m3 ? m3[1] : "null");
console.log("Test 3 PASS:", name3 === "raju" && m3 && m3[1] === "C:\\Users\\pilli\\Downloads\\raju");

// Check if cmd3 contains 'shanu'
console.log("\nTest 3 cmd contains 'shanu':", cmd3.includes("shanu"));
console.log("Test 3 cmd contains 'raju':", cmd3.includes("raju"));

// Test 4: Check the mock test behavior
// In authorizedExecutor.test.ts, the mock returns stdout based on the extracted path
// For test3, if the mock extracts the path correctly:
if (m3) {
    const p = m3[1].replace(/\.\//g, "").replace(/\\\.\\/, "");
    console.log("\nMock stdout for Test 3:", "C:\\mock\\" + p);
}

// Test 5: What if hasExplicitTarget is checked on userText with the path?
const userText3 = test3;
console.log("\nhasExplicitTarget on userText3:", hasExplicitTarget(userText3));
console.log("userText3 includes 'path' keyword:", /\bpath\b/i.test(userText3));
console.log("userText3 includes 'it':", /\bit\b/i.test(userText3));
