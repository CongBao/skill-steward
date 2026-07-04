import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NativeCodexFixture {
  cacheRoot: string;
  skillPath: string;
}

export async function installNativeCodexFixture(
  home: string,
  name = "native-review",
  skillSource = `---\nname: ${name}\ndescription: Review native plugin changes and tests\n---\n`
): Promise<NativeCodexFixture> {
  const cacheRoot = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "fixture-marketplace",
    "fixture-plugin",
    "1.0.0"
  );
  const skillPath = join(cacheRoot, "skills", name);
  await mkdir(join(cacheRoot, ".codex-plugin"), { recursive: true });
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(cacheRoot, ".codex-plugin", "plugin.json"), "{}\n");
  await writeFile(
    join(home, ".codex", "config.toml"),
    '[plugins."fixture-plugin@fixture-marketplace"]\nenabled = true\n'
  );
  await writeFile(
    join(skillPath, "SKILL.md"),
    skillSource
  );
  return { cacheRoot, skillPath };
}
