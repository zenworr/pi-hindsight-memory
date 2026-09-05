import fs from "node:fs/promises";

let mission: Promise<string> | undefined;

export function expectedRetainMission(): Promise<string> {
  return mission ??= fs.readFile(new URL("../../../deploy/compose/bank-config.json", import.meta.url), "utf8")
    .then((text) => (JSON.parse(text) as { bank: { retain_mission: string } }).bank.retain_mission);
}
