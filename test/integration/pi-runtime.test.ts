import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../../src/common/config.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { HINDSIGHT_STATUS_REQUEST_EVENT, type HindsightStatusSnapshotV1 } from "../../src/extension/status.js";

test("Pi loads the package without warnings and restores one memory_search tool and clean status across reloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-sdk-"));
  let recalls = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-only-token");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ status: "healthy", database: "connected" }));
    else if (request.url?.endsWith("/stats")) response.end(JSON.stringify({ total_documents: 1 }));
    else if (request.url?.includes("/operations?")) response.end(JSON.stringify({ operations: [] }));
    else if (request.url?.endsWith("/memories/recall")) { recalls += 1; response.end(JSON.stringify({ results: [{ id: "test", text: "Synthetic memory result", scores: { final: 0.5 } }] })); }
    else { response.statusCode = 404; response.end("{}"); }
  });
  t.after(async () => {
    server.closeAllConnections(); server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = defaultConfig(root);
  config.hindsight.apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const state = new StateDatabase(config.stateDatabase);
  state.heartbeat("idle"); state.close();
  await fs.mkdir(path.dirname(config.configPath), { recursive: true });
  await fs.writeFile(config.configPath, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(config.hindsight.apiTokenFile, "test-only-token", { mode: 0o600 });
  const environment = {
    PI_HINDSIGHT_CONFIG: config.configPath,
    PI_HINDSIGHT_API_URL: config.hindsight.apiUrl,
    PI_HINDSIGHT_API_TOKEN_FILE: config.hindsight.apiTokenFile,
    PI_OFFLINE: "1",
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const bus = createEventBus();
  const settings = SettingsManager.inMemory({ packages: [path.resolve(".")], extensions: [] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, eventBus: bus, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(root, "models.json"), modelsStorePath: path.join(root, "models-store.json"), allowModelNetwork: false });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), modelRuntime });
  const errors: unknown[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    for (let round = 0; round < 4; round += 1) {
      if (round > 0) await session.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.warnings, []);
      assert.equal(loaded.extensions[0]?.sourceInfo.origin, "package");
      assert.equal(session.agent.state.tools.filter((tool) => tool.name === "memory_search").length, 1);
      let result: Promise<HindsightStatusSnapshotV1> | undefined;
      bus.emit(HINDSIGHT_STATUS_REQUEST_EVENT, { protocolVersion: 1, respond(value: Promise<HindsightStatusSnapshotV1>) { result = value; } });
      assert.ok(result);
      const status = await result;
      assert.equal(status.service.documents, 1);
      assert.deepEqual(status.issues, []);
    }
    assert.equal(recalls, 0, "startup and reload never recall memory automatically");
    const tool = session.agent.state.tools.find((tool) => tool.name === "memory_search")!;
    const result = await tool.execute("explicit", { query: "Synthetic memory" });
    assert.match(String((result.content[0] as { text: string }).text), /Synthetic memory result/);
    assert.equal(recalls, 1);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
