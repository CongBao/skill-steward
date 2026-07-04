import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("loads the plain TypeScript-compiled metadata module in Node ESM", async () => {
  const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
  const output = await mkdtemp(join(packageDirectory, ".node-runtime-"));
  try {
    await execFileAsync(join(packageDirectory, "../../node_modules/.bin/tsc"), [
      "-p",
      "tsconfig.json",
      "--outDir",
      output
    ], { cwd: packageDirectory });
    const metadataUrl = pathToFileURL(
      join(output, "src", "inventory", "metadata.js")
    ).href;
    const script = [
      `import { parseJsoncObject } from ${JSON.stringify(metadataUrl)};`,
      'const value = parseJsoncObject("{ // comment\\n \\\"enabled\\\": true, }");',
      'if (value.enabled !== true) throw new Error("JSONC parse failed");'
    ].join("\n");

    await expect(execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      script
    ], { cwd: packageDirectory })).resolves.toBeDefined();
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
