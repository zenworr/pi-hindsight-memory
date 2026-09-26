import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
assert.equal(manifest.version, lock.version, "package and lock versions differ");
assert.equal(manifest.version, lock.packages[""].version, "lock root version differs");
for (const group of ["dependencies", "devDependencies"]) {
  assert.deepEqual(manifest[group], lock.packages[""][group], `${group} differs from the lockfile`);
  for (const [name, version] of Object.entries(manifest[group])) assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must use an exact version`);
}
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const files = new Set(pack.files.map(file => file.path));
for (const file of ["dist/src/importer/cli.js", "dist/src/extension/index.js", "dist/src/extension/status.js", "deploy/compose/bank-config.json", "deploy/compose/bank-config.no-llm.json", "README.md", "LICENSE", "package.json"]) assert.ok(files.has(file), `package is missing ${file}`);
for (const file of files) assert.match(file, /^(?:dist\/src\/.+\.(?:js|js\.map|d\.ts)|deploy\/compose\/bank-config(?:\.no-llm)?\.json|README\.md|LICENSE|package\.json)$/, `unexpected package file: ${file}`);
process.stdout.write(`Package ${manifest.version}: ${files.size} allowed files; metadata and dependency pins match.\n`);
