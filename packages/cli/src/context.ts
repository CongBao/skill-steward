import { join } from "node:path";
import type { RefreshCatalogInput } from "@skill-steward/catalog";

export interface CliContext {
  cwd: string;
  home: string;
  stateDir: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  stdin?: () => Promise<string>;
  catalogInspect?: RefreshCatalogInput["inspect"];
  now?: () => Date;
}

export function defaultContext(): CliContext {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return {
    cwd: process.cwd(),
    home,
    stateDir: process.env.SKILL_STEWARD_HOME ?? join(home, ".skill-steward"),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    stdin: async () => {
      process.stdin.setEncoding("utf8");
      let value = "";
      for await (const chunk of process.stdin) value += chunk;
      return value;
    }
  };
}
