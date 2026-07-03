import { access, mkdir } from "node:fs/promises";
import type { CliContext } from "../context.js";

export async function doctorCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  await access(context.stateDir);
  const result = {
    node: process.version,
    stateDir: context.stateDir,
    stateWritable: true
  };
  context.stdout(
    json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Node: ${result.node}\nState: ${result.stateDir}\nWritable: yes\n`
  );
  return 0;
}
