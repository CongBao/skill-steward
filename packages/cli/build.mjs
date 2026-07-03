import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const workspaceDirectory = fileURLToPath(new URL("../../", import.meta.url));
const outputDirectory = fileURLToPath(new URL("./dist/", import.meta.url));
const dashboardPackageDirectory = fileURLToPath(new URL("../../apps/dashboard/", import.meta.url));
const dashboardSource = join(dashboardPackageDirectory, "dist");
const dashboardDestination = join(outputDirectory, "dashboard");
const integrationsSource = fileURLToPath(new URL("../integrations/assets/", import.meta.url));
const integrationsDestination = join(outputDirectory, "integrations");
const manifestPath = join(outputDirectory, "third-party-manifest.json");
const noticesPath = join(outputDirectory, "THIRD_PARTY_NOTICES.txt");
const packageCache = new Map();

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function packageAt(root) {
  const physicalRoot = await realpath(root);
  const cached = packageCache.get(physicalRoot);
  if (cached) return cached;
  const manifest = await readJson(join(physicalRoot, "package.json"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Package metadata is missing name or version: ${relative(workspaceDirectory, physicalRoot)}`);
  }
  const value = { root: physicalRoot, manifest };
  packageCache.set(physicalRoot, value);
  return value;
}

async function nearestPackage(path) {
  let current = dirname(path);
  while (true) {
    if (await existingFile(join(current, "package.json"))) return packageAt(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function workspacePackages() {
  const packages = new Map();
  for (const parent of ["packages", "apps"]) {
    const directory = join(workspaceDirectory, parent);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(directory, entry.name);
      if (!await existingFile(join(root, "package.json"))) continue;
      const value = await packageAt(root);
      packages.set(value.manifest.name, value);
    }
  }
  return packages;
}

function insideWorkspace(path) {
  const value = relative(workspaceDirectory, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function resolveDependency(name, from, workspaces) {
  const workspace = workspaces.get(name);
  if (workspace) return workspace;
  for (const candidate of [
    join(from.root, "node_modules", ...name.split("/")),
    join(dirname(from.root), ...name.split("/"))
  ]) {
    if (await existingFile(join(candidate, "package.json"))) return packageAt(candidate);
  }
  const require = createRequire(join(from.root, "package.json"));
  let entry;
  try {
    entry = require.resolve(name);
  } catch (error) {
    throw new Error(`Runtime dependency '${name}' from ${from.manifest.name} cannot be resolved`, {
      cause: error
    });
  }
  const resolved = await nearestPackage(entry);
  if (!resolved || resolved.manifest.name !== name) {
    throw new Error(`Runtime dependency '${name}' from ${from.manifest.name} cannot be mapped`);
  }
  return resolved;
}

function sourceUrl(manifest) {
  const repository = typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository?.url;
  const source = repository || manifest.homepage;
  if (source === undefined) return undefined;
  if (typeof source !== "string" || isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("file:")) {
    throw new Error(`Package ${manifest.name}@${manifest.version} has an unsafe source URL`);
  }
  return source;
}

function declaredLicense(manifest) {
  if (typeof manifest.license !== "string" || manifest.license.trim() === "") {
    throw new Error(`Package ${manifest.name}@${manifest.version} has no declared license`);
  }
  const license = manifest.license.trim();
  if (/^SEE LICENSE IN\b/i.test(license)) {
    throw new Error(`Package ${manifest.name}@${manifest.version} has no SPDX license expression`);
  }
  return license;
}

async function licenseFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compare);
}

async function packageRootsFromMetafile(metafile, surface) {
  const values = [];
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("<")) continue;
    const absolute = isAbsolute(input) ? input : resolve(workspaceDirectory, input);
    const owner = await nearestPackage(absolute);
    if (!owner) throw new Error(`Bundle input cannot be mapped to a package: ${input}`);
    values.push({ owner, surface });
  }
  return values;
}

async function runtimeClosure(cliMetafile, dashboardMetafile) {
  const workspaces = await workspacePackages();
  const thirdParty = new Map();
  const visited = new Set();

  async function visit(value, surface) {
    const key = `${value.root}\0${surface}`;
    if (visited.has(key)) return;
    visited.add(key);
    const workspace = workspaces.get(value.manifest.name);
    const isWorkspace = workspace?.root === value.root && insideWorkspace(value.root);
    if (!isWorkspace) {
      const identifier = `${value.manifest.name}@${value.manifest.version}`;
      const existing = thirdParty.get(identifier) ?? { value, surfaces: new Set() };
      existing.surfaces.add(surface);
      thirdParty.set(identifier, existing);
    }
    for (const dependency of Object.keys(value.manifest.dependencies ?? {}).sort(compare)) {
      await visit(await resolveDependency(dependency, value, workspaces), surface);
    }
  }

  for (const input of await packageRootsFromMetafile(cliMetafile, "cli-bundle")) {
    await visit(input.owner, input.surface);
  }
  for (const input of await packageRootsFromMetafile(dashboardMetafile, "dashboard-bundle")) {
    await visit(input.owner, input.surface);
  }
  await visit(await packageAt(dashboardPackageDirectory), "dashboard-runtime");

  const packages = [];
  for (const [identifier, entry] of [...thirdParty.entries()].sort(([left], [right]) => compare(left, right))) {
    const files = await licenseFiles(entry.value.root);
    const texts = [];
    for (const file of files) {
      texts.push({
        file,
        text: (await readFile(join(entry.value.root, file), "utf8")).replace(/\r\n/g, "\n").trimEnd()
      });
    }
    packages.push({
      identifier,
      name: entry.value.manifest.name,
      version: entry.value.manifest.version,
      license: declaredLicense(entry.value.manifest),
      ...(sourceUrl(entry.value.manifest) ? { source: sourceUrl(entry.value.manifest) } : {}),
      surfaces: [...entry.surfaces].sort(compare),
      licenseFiles: files,
      texts
    });
  }
  return packages;
}

function renderNotices(packages) {
  const lines = [
    "# Third-Party Notices",
    "",
    "Skill Steward includes the following third-party software in its packaged CLI and dashboard.",
    ""
  ];
  for (const entry of packages) {
    lines.push(`## ${entry.identifier}`);
    lines.push(`License: ${entry.license}`);
    if (entry.source) lines.push(`Source: ${entry.source}`);
    lines.push(`Included in: ${entry.surfaces.join(", ")}`);
    for (const license of entry.texts) {
      lines.push("");
      lines.push(`### ${license.file}`);
      lines.push("");
      lines.push(license.text);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const cliBuild = await build({
  absWorkingDir: workspaceDirectory,
  entryPoints: [join(packageDirectory, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(outputDirectory, "main.js"),
  metafile: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
});
const dashboardAnalysis = await build({
  absWorkingDir: workspaceDirectory,
  entryPoints: [join(dashboardPackageDirectory, "src/main.tsx")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  metafile: true,
  minify: true,
  outdir: join(outputDirectory, ".dashboard-analysis"),
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent"
});
if (!cliBuild.metafile || !dashboardAnalysis.metafile) {
  throw new Error("Runtime dependency analysis did not produce an esbuild metafile");
}
const dependencies = await runtimeClosure(cliBuild.metafile, dashboardAnalysis.metafile);
const publicManifest = {
  schemaVersion: 1,
  packages: dependencies.map(({ texts: _texts, identifier: _identifier, ...entry }) => entry)
};
await writeFile(manifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`, "utf8");
await writeFile(noticesPath, renderNotices(dependencies), "utf8");
await cp(dashboardSource, dashboardDestination, { recursive: true });
await cp(integrationsSource, integrationsDestination, { recursive: true });
