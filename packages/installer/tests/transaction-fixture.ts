import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintDirectory } from "../src/manifest.js";

export async function createSkill(directory: string, body: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: review\ndescription: review\n---\n${body}\n`
  );
  return fingerprintDirectory(directory);
}
