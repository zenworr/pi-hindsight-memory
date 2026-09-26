import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const files = ["README.md", ...fs.readdirSync("docs").filter(file => file.endsWith(".md")).map(file => path.join("docs", file))];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `unclosed code fence: ${file}`);
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (target.includes("://") || target.startsWith("mailto:")) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${file} has a missing local link: ${target}`);
  }
}
process.stdout.write(`Local links and code fences checked in ${files.length} documents.\n`);
