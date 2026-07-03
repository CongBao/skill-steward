import { join } from "node:path";
import type { RefreshCatalogInput } from "@skill-steward/catalog";
import type { stagePublicGit } from "@skill-steward/installer";

export interface CliContext {
  cwd: string;
  home: string;
  stateDir: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  stdin?: (maxBytes?: number) => Promise<string>;
  catalogInspect?: RefreshCatalogInput["inspect"];
  catalogStage?: typeof stagePublicGit;
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
    stdin: async (maxBytes = Number.POSITIVE_INFINITY) => {
      process.stdin.setEncoding("utf8");
      let value = "";
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > maxBytes) throw new Error(`Standard input exceeds ${maxBytes} bytes`);
        value += chunk;
      }
      return value;
    }
  };
}
