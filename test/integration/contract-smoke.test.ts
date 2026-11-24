import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { sha256 } from "../../src/common/hashing.js";

test("disposable contract smoke verifies replacement hashes and removes its bank on failure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-contract-"));
  const bin = path.join(home, "bin");
  const config = path.join(home, "config.json");
  const tokenFile = path.join(home, "api-token");
  let exists = false;
  let documentHash: string | undefined;
  let ignoreReplacement = false;
  const requests: string[] = [];
  const bankIds = new Set<string>();
  const server = http.createServer((request, response) => {
    const match = request.url?.match(/^\/v1\/default\/banks\/(coding-history-contract-[0-9a-f-]+)(.*)$/);
    function send(value: unknown, status = 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    }
    if (!match) { send({}, 404); return; }
    bankIds.add(match[1]!);
    const route = `${request.method} ${match[2]}`;
    requests.push(route);
    if (route === "GET /config") send({ config: { retain_strategies: { conversation: { retain_extraction_mode: "chunks" } } } }, exists ? 200 : 404);
    else if (route === "PUT ") { exists = true; send({}); }
    else if (route === "POST /import") send({});
    else if (route === "POST /memories") {
      let raw = "";
      request.setEncoding("utf8").on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw) as { operation_id: string; items: Array<{ content: string }> };
        if (!documentHash || !ignoreReplacement) documentHash = sha256(body.items[0]!.content);
        send({ operation_id: body.operation_id }, 202);
      });
    } else if (route.startsWith("GET /operations/")) send({ status: "completed" });
    else if (route === "POST /memories/recall") send({ results: [{ text: "Contract sentinel alpha" }] });
    else if (route.startsWith("GET /documents/")) send({ content_hash: documentHash }, documentHash ? 200 : 404);
    else if (route.startsWith("DELETE /documents/")) { documentHash = undefined; send({}); }
    else if (route === "DELETE ") { exists = false; documentHash = undefined; send({}); }
    else send({}, 404);
  });
  try {
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    await fs.symlink(process.execPath, path.join(bin, "node"));
    await fs.writeFile(tokenFile, "test-contract-token\n", { mode: 0o600 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    await fs.writeFile(config, JSON.stringify({ hindsight: { apiUrl, apiTokenFile: tokenFile } }));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, PI_HINDSIGHT_CONFIG: config, PI_HINDSIGHT_API_URL: apiUrl, PI_HINDSIGHT_API_TOKEN_FILE: tokenFile, PATH: `${bin}:${process.env.PATH}` };
    const runSmoke = () => promisify(execFile)("bash", ["scripts/live-contract-smoke.sh"], { env, timeout: 10_000 });

    const { stdout } = await runSmoke();
    assert.match(stdout, /"ok":true/);
    assert.ok(requests.some(route => route.startsWith("DELETE /documents/")));
    assert.equal(requests.at(-1), "DELETE ");
    assert.equal(exists, false);

    ignoreReplacement = true;
    await assert.rejects(runSmoke(), /stored document hash does not match/);
    assert.equal(requests.at(-1), "DELETE ");
    assert.equal(exists, false);
    assert.equal(bankIds.size, 2);
  } finally {
    server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
