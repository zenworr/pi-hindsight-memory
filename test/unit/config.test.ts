import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { defaultConfig } from "../../src/common/config.js";
import { defaultConfigDirectory, defaultStateDirectory } from "../../src/common/paths.js";

test("portable defaults are generic and follow XDG directories", () => {
  const oldConfig = process.env.XDG_CONFIG_HOME;
  const oldState = process.env.XDG_STATE_HOME;
  const configRoot = path.join(os.tmpdir(), "pi-hm-xdg-config");
  const stateRoot = path.join(os.tmpdir(), "pi-hm-xdg-state");
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    assert.equal(defaultConfigDirectory(), path.join(configRoot, "pi-hindsight-memory"));
    assert.equal(defaultStateDirectory(), path.join(stateRoot, "pi-hindsight-memory"));
    const config = defaultConfig();
    assert.equal(config.hindsight.bankId, "coding-history");
    assert.equal(config.hindsight.uiUrl, "http://127.0.0.1:9999");
    assert.equal(config.hindsight.minRelevanceScore, 0.01);
    assert.deepEqual(config.sessionExclusions.exactLabels, []);
    assert.equal(config.maxInflightDocuments, 4);
    assert.equal(config.configPath, path.join(configRoot, "pi-hindsight-memory", "config.json"));
    assert.equal(config.stateDatabase, path.join(stateRoot, "pi-hindsight-memory", "state.sqlite3"));
  } finally {
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
  }
});

test("agent-specific home variables are honored for the active home", () => {
  const saved = { pi: process.env.PI_CODING_AGENT_DIR, codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR, data: process.env.XDG_DATA_HOME };
  process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "custom-pi");
  process.env.CODEX_HOME = path.join(os.tmpdir(), "custom-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "custom-claude");
  process.env.XDG_DATA_HOME = path.join(os.tmpdir(), "custom-data");
  try {
    const config = defaultConfig();
    assert.equal(config.sourceRoots.pi, path.join(process.env.PI_CODING_AGENT_DIR, "sessions"));
    assert.equal(config.sourceRoots.codex, path.join(process.env.CODEX_HOME, "sessions"));
    assert.equal(config.sourceRoots.claude, path.join(process.env.CLAUDE_CONFIG_DIR, "projects"));
    assert.equal(config.opencodeDatabase, path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"));
  } finally {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.pi], ["CODEX_HOME", saved.codex], ["CLAUDE_CONFIG_DIR", saved.claude], ["XDG_DATA_HOME", saved.data]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("an explicit home remains deterministic when XDG variables are set", () => {
  const oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "unrelated-xdg");
  try {
    const home = path.join(os.tmpdir(), "explicit-home");
    assert.equal(defaultConfig(home).configPath, path.join(home, ".config", "pi-hindsight-memory", "config.json"));
  } finally {
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  }
});
