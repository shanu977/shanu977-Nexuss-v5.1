const clause = 'create a folder called shanu 1999';
const m = clause.match(/(?:folder|directory|project)\s+(?:called\s+|named\s+|name\s+called\s+)?["']?([a-zA-Z0-9_\- ]+?)["']?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
console.log('m[1]:', m ? m[1] : 'null');

const clause2 = 'create a folder in this path name it as raju';
const m2 = clause2.match(/name\s+it\s+as\s+["']?([a-zA-Z0-9_\- ]+)["']?/i);
console.log('m2[1]:', m2 ? m2[1] : 'null');

// Test extractAbsolutePath
const absMatch = clause2.match(/([a-zA-Z]:\\[^\s"'`,;]+)/);
console.log('absPath:', absMatch ? absMatch[1] : 'null');

// Test hasExplicitTarget
const hasExplicit = /[a-zA-Z]:[\\/]/.test(clause2);
console.log('hasExplicit:', hasExplicit);

// Test the full regex for m with shanu 1999
const m3 = clause.match(/(?:folder|directory|project)\s+(?:called\s+|named\s+|name\s+called\s+)?["']?([a-zA-Z0-9_\- ]+?)["']?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
if (m3) {
    const raw = m3[1].trim().replace(/["'`]/g, "");
    const cleaned = raw.replace(/\s+/g, " ").trim();
    console.log('raw:', raw);
    console.log('cleaned:', cleaned);
    console.log('should return:', cleaned.toLowerCase() !== "in this path name it as raju" && !cleaned.toLowerCase().startsWith("in this path") ? cleaned : 'fallback');
}

// Test what happens with a path + name it as
const clause4 = 'C:\\Users\\pilli\\Downloads create a folder in this path name it as raju';
const m4 = clause4.match(/name\s+it\s+as\s+["']?([a-zA-Z0-9_\- ]+)["']?/i);
console.log('m4[1] for explicit path:', m4 ? m4[1] : 'null');

// Test extractFolderName on the path clause
const m5 = clause4.match(/(?:folder|directory|project)\s+(?:called\s+|named\s+|name\s+called\s+)?["']?([a-zA-Z0-9_\- ]+?)["']?(?:\s+and|\s*$|\s+inside|\s+here|\.|,|;)/i);
if (m5) {
    const raw5 = m5[1].trim().replace(/["'`]/g, "");
    const cleaned5 = raw5.replace(/\s+/g, " ").trim();
    console.log('m5 raw:', raw5);
    console.log('m5 cleaned:', cleaned5);
}

// Test basePath extraction
const absMatch4 = clause4.match(/([a-zA-Z]:\\[^\s"'`,;]+)/);
console.log('absPath for clause4:', absMatch4 ? absMatch4[1] : 'null');

// Test what the command would look like
const name = m4 ? m4[1].trim().replace(/\s+/g, " ").trim().replace(/["'`]/g, "") : null;
const basePath = absMatch4 ? absMatch4[1] : null;
console.log('name:', name);
console.log('basePath:', basePath);
if (name && basePath) {
    const safe = name.replace(/["'`$]/g, "");
    const cleanBase = basePath.replace(/["'`$]/g, "").replace(/\\/g, "\\");
    const normalizedBase = cleanBase.replace(/[\\/]+$/, "");
    const full = `${normalizedBase}\\${safe}`;
    const safeFull = full.replace(/"/g, "");
    console.log('Command path:', safeFull);
}
