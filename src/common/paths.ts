import os from "node:os";
import path from "node:path";

export function homeDirectory(): string {
  return process.env.HOME || os.homedir();
}

export function defaultConfigDirectory(home = homeDirectory()): string {
  const base = home === homeDirectory() ? process.env.XDG_CONFIG_HOME : undefined;
  return path.join(base ? path.resolve(base) : path.join(home, ".config"), "pi-hindsight-memory");
}

export function defaultStateDirectory(home = homeDirectory()): string {
  const base = home === homeDirectory() ? process.env.XDG_STATE_HOME : undefined;
  return path.join(base ? path.resolve(base) : path.join(home, ".local", "state"), "pi-hindsight-memory");
}

export function defaultRuntimePaths(home = homeDirectory()) {
  const configDirectory = defaultConfigDirectory(home);
  const stateDirectory = defaultStateDirectory(home);
  return {
    configDirectory,
    configPath: path.join(configDirectory, "config.json"),
    tokenPath: path.join(configDirectory, "api-token"),
    environmentPath: path.join(configDirectory, "hindsight.env"),
    stateDirectory,
    stateDatabase: path.join(stateDirectory, "state.sqlite3"),
    reportDirectory: path.join(stateDirectory, "reports"),
    spoolDirectory: path.join(stateDirectory, "canonical"),
    lockPath: path.join(stateDirectory, "daemon.lock"),
  };
}

export function expandHome(value: string, home = homeDirectory()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function absolutePath(value: string, home = homeDirectory()): string {
  return path.resolve(expandHome(value, home));
}
