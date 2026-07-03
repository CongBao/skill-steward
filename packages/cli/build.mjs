import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = fileURLToPath(new URL("./dist/", import.meta.url));
const dashboardSource = fileURLToPath(
  new URL("../../apps/dashboard/dist/", import.meta.url)
);
const dashboardDestination = fileURLToPath(
  new URL("./dist/dashboard/", import.meta.url)
);

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [`${packageDirectory}src/main.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${outputDirectory}main.js`,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
});
await rm(dashboardDestination, { recursive: true, force: true });
await cp(dashboardSource, dashboardDestination, { recursive: true });
