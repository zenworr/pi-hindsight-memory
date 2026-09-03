import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [path.join(root, "scripts", script), ...args], { cwd: root, env, encoding: "utf8" });
}

test("setup configuration uses generic portable defaults and local overrides", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-portable-config-"));
  const configHome = path.join(home, "config-root");
  const stateHome = path.join(home, "state-root");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, PI_HINDSIGHT_BANK_ID: "team-history", PI_HINDSIGHT_MAX_INFLIGHT: "6" };
  try {
    const result = run("create-config.sh", [], env);
    assert.equal(result.status, 0, result.stderr);
    const pathname = path.join(configHome, "pi-hindsight-memory", "config.json");
    const config = JSON.parse(await fs.readFile(pathname, "utf8"));
    assert.equal(config.hindsight.bankId, "team-history");
    assert.equal(config.maxInflightDocuments, 6);
    assert.deepEqual(config.sessionExclusions.exactLabels, []);
    assert.equal(config.sourceRoots.pi, path.join(home, ".pi", "agent", "sessions"));
    assert.equal(config.opencodeDatabase, path.join(home, ".local", "share", "opencode", "opencode.db"));
    assert.equal((await fs.stat(pathname)).mode & 0o777, 0o600);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("Compose persists PostgreSQL at its version-aware parent directory", async () => {
  const compose = await fs.readFile(path.join(root, "deploy", "compose", "compose.yaml"), "utf8");
  assert.match(compose, /hindsight_pg_data:\/var\/lib\/postgresql\n/);
  assert.doesNotMatch(compose, /hindsight_pg_data:\/var\/lib\/postgresql\//);
});

test("Linux importer service can depend on a remote tunnel", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-portable-systemd-"));
  const configHome = path.join(home, "config-root");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(configHome, "pi-hindsight-memory"), { recursive: true });
  await fs.writeFile(path.join(configHome, "pi-hindsight-memory", "config.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(bin, "uname"), "#!/usr/bin/env bash\necho Linux\n", { mode: 0o700 });
  for (const name of ["node", "npm", "systemctl"]) await fs.writeFile(path.join(bin, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, PATH: `${bin}:${process.env.PATH}`, PI_HINDSIGHT_IMPORTER_DEPENDENCY: "pi-hindsight-tunnel.service" };
  try {
    const result = run("install-importer-service.sh", [], env);
    assert.equal(result.status, 0, result.stderr);
    const unit = await fs.readFile(path.join(home, ".config", "systemd", "user", "pi-hindsight-importer.service"), "utf8");
    assert.match(unit, /^Wants=network-online\.target pi-hindsight-tunnel\.service$/m);
    assert.match(unit, /^After=network-online\.target pi-hindsight-tunnel\.service$/m);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("remote backup streams PostgreSQL over SSH and snapshots local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-remote-backup-"));
  const stateHome = path.join(home, "state-root");
  const stateDirectory = path.join(stateHome, "pi-hindsight-memory");
  const backupDirectory = path.join(home, "backups");
  const bin = path.join(home, "bin");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "state.sqlite3"), "state-data\n", { mode: 0o600 });
  await fs.writeFile(path.join(bin, "ssh"), `#!/usr/bin/env bash
case "$*" in
  *" ps --format "*) echo hindsight-db ;;
  *" pg_dump "*) printf 'postgres-dump\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, "sqlite3"), `#!/usr/bin/env bash
if [[ $2 == .backup* ]]; then target=\${2#*\\'}; target=\${target%\\'}; cp "$1" "$target"; else echo ok; fi
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: stateHome, PATH: `${bin}:${process.env.PATH}`, PI_HINDSIGHT_BACKUP_DIR: backupDirectory, PI_HINDSIGHT_SSH_HOST: "hindsight-test" };
  try {
    const result = run("backup.sh", [], env);
    assert.equal(result.status, 0, result.stderr);
    const files = await fs.readdir(backupDirectory);
    const dump = files.find((name) => /^hindsight-.*\.dump$/.test(name));
    const state = files.find((name) => /^state-.*\.sqlite3$/.test(name));
    assert.ok(dump);
    assert.ok(state);
    assert.equal(await fs.readFile(path.join(backupDirectory, dump), "utf8"), "postgres-dump\n");
    assert.equal(await fs.readFile(path.join(backupDirectory, state), "utf8"), "state-data\n");
    assert.equal((await fs.stat(path.join(backupDirectory, dump))).mode & 0o777, 0o600);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("macOS importer service stays staged until explicit activation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-portable-launchd-"));
  const configHome = path.join(home, "config-root");
  const stateHome = path.join(home, "state-root");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(configHome, "pi-hindsight-memory"), { recursive: true });
  await fs.writeFile(path.join(configHome, "pi-hindsight-memory", "config.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(bin, "uname"), "#!/usr/bin/env bash\necho Darwin\n", { mode: 0o700 });
  for (const name of ["node", "npm", "plutil"]) await fs.writeFile(path.join(bin, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, PATH: `${bin}:${process.env.PATH}` };
  try {
    const result = run("install-importer-service.sh", [], env);
    assert.equal(result.status, 0, result.stderr);
    const label = "dev.pi-hindsight-memory.importer.plist";
    const staged = path.join(configHome, "pi-hindsight-memory", label);
    const active = path.join(home, "Library", "LaunchAgents", label);
    assert.equal(await fs.stat(staged).then(() => true, () => false), true);
    assert.equal(await fs.stat(active).then(() => true, () => false), false);
    const plist = await fs.readFile(staged, "utf8");
    assert.match(plist, /<string>--config<\/string>/);
    assert.match(plist, new RegExp(path.join(configHome, "pi-hindsight-memory", "config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("Pi installer preserves unrelated packages and restores settings on failure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-portable-pi-install-"));
  const agent = path.join(home, "agent");
  const bin = path.join(home, "bin");
  const settings = path.join(agent, "settings.json");
  const original = JSON.stringify({ packages: ["npm:unrelated-extension"] });
  await fs.mkdir(agent, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(settings, original, { mode: 0o600 });
  await fs.writeFile(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(path.join(bin, "node"), "#!/usr/bin/env bash\nif [[ ${1:-} == -e ]]; then echo relative-package; fi\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(path.join(bin, "pi"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  list) echo unrelated-extension ;;
  install)
    [[ \${TEST_PI_INSTALL_FAIL:-0} != 1 ]] || exit 8
    tmp=$(mktemp "$PI_CODING_AGENT_DIR/settings.json.XXXXXX")
    jq --arg package "$2" '.packages += [$package]' "$PI_CODING_AGENT_DIR/settings.json" > "$tmp"
    mv "$tmp" "$PI_CODING_AGENT_DIR/settings.json"
    ;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}` };
  try {
    const installed = run("install-pi-extension.sh", [], env);
    assert.equal(installed.status, 0, installed.stderr);
    const packages = JSON.parse(await fs.readFile(settings, "utf8")).packages;
    assert.equal(packages[0], "npm:unrelated-extension");
    assert.equal(packages[1], root);

    await fs.writeFile(settings, original, { mode: 0o600 });
    const failed = run("install-pi-extension.sh", [], { ...env, TEST_PI_INSTALL_FAIL: "1" });
    assert.equal(failed.status, 8);
    assert.equal(await fs.readFile(settings, "utf8"), original);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("API-key provider helper verifies changes without exposing the key and rolls back failures", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-portable-provider-"));
  const configHome = path.join(home, "config-root");
  const stateHome = path.join(home, "state-root");
  const directory = path.join(configHome, "pi-hindsight-memory");
  const envFile = path.join(directory, "hindsight.env");
  const bin = path.join(home, "bin");
  const key = "sk-test-portability-secret";
  const original = "HINDSIGHT_API_LLM_PROVIDER=none\nHINDSIGHT_API_LLM_MODEL=old\nHINDSIGHT_API_LLM_API_KEY=old-secret\n";
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ hindsight: { apiUrl: "http://127.0.0.1:8888" } }));
  for (const name of ["docker", "curl"]) await fs.writeFile(path.join(bin, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(path.join(bin, "node"), "#!/usr/bin/env bash\n[[ ${TEST_PROVIDER_FAIL:-0} == 1 ]] && exit 9\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, PATH: `${bin}:${process.env.PATH}`, PI_HINDSIGHT_CONTAINER_ENGINE: "docker", TEST_PROVIDER_KEY: key };
  try {
    await fs.writeFile(envFile, original, { mode: 0o600 });
    const missingModel = run("configure-provider.sh", ["--api-key-env", "TEST_PROVIDER_KEY"], env);
    assert.notEqual(missingModel.status, 0);
    assert.equal(await fs.readFile(envFile, "utf8"), original);

    const result = run("configure-provider.sh", ["--provider", "openai-responses", "--model", "model-test", "--reasoning", "xhigh", "--api-key-env", "TEST_PROVIDER_KEY"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(`${result.stdout}${result.stderr}`.includes(key), false);
    const text = await fs.readFile(envFile, "utf8");
    assert.match(text, /^HINDSIGHT_API_LLM_PROVIDER=openai-responses$/m);
    assert.match(text, /^HINDSIGHT_API_LLM_MODEL=model-test$/m);
    assert.match(text, /^HINDSIGHT_API_LLM_REASONING_EFFORT=xhigh$/m);
    assert.match(text, new RegExp(`^HINDSIGHT_API_LLM_API_KEY=${key}$`, "m"));
    assert.equal(text.includes("old-secret"), false);
    assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);

    await fs.writeFile(envFile, original, { mode: 0o600 });
    const failed = run("configure-provider.sh", ["--model", "failing-model", "--api-key-env", "TEST_PROVIDER_KEY"], { ...env, TEST_PROVIDER_FAIL: "1" });
    assert.notEqual(failed.status, 0);
    assert.equal(await fs.readFile(envFile, "utf8"), original);
    assert.equal(`${failed.stdout}${failed.stderr}`.includes(key), false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
