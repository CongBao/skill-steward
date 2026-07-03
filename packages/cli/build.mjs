import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  assertNoUnusedLicenseOverrides,
  extractReadmeLicenseSection,
  normalizeSourceUrl,
  takeLicenseOverride,
  validateAttributableLicenseText,
  validateLicenseOverrides,
  validateSpdxExpression
} from "./license-compliance.mjs";

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
const licenseOverridesPath = join(packageDirectory, "license-overrides.json");
const packageCache = new Map();
const modulePreloadSignature = /relList[\s\S]+modulepreload[\s\S]+MutationObserver/;

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
  try {
    return normalizeSourceUrl(source);
  } catch (error) {
    throw new Error(`Package ${manifest.name}@${manifest.version} has an unsafe source URL`, {
      cause: error
    });
  }
}

function declaredLicense(manifest) {
  if (typeof manifest.license !== "string" || manifest.license.trim() === "") {
    throw new Error(`Package ${manifest.name}@${manifest.version} has no declared license`);
  }
  return validateSpdxExpression(manifest.license);
}

async function licenseFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compare);
}

async function licenseAttributions(identifier, root, overrides, usedOverrides) {
  const files = await licenseFiles(root);
  if (files.length > 0) {
    return Promise.all(files.map(async (file) => ({
      kind: "file",
      source: file,
      text: validateAttributableLicenseText(
        await readFile(join(root, file), "utf8"),
        `${identifier} ${file}`
      )
    })));
  }

  const readmes = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^readme(?:$|[._-])/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compare);
  for (const readme of readmes) {
    const section = extractReadmeLicenseSection(await readFile(join(root, readme), "utf8"), readme);
    if (section) {
      try {
        validateAttributableLicenseText(section.text, `${identifier} ${section.source}`, {
          requireCopyright: true
        });
        return [section];
      } catch {
        // A link or SPDX label alone is not license text; an audited override may follow.
      }
    }
  }

  const override = takeLicenseOverride(overrides, identifier, usedOverrides);
  if (override) return [override];
  throw new Error(`Package ${identifier} has no complete attributable license text`);
}

async function assertViteModulePreloadRuntime() {
  const assets = join(dashboardSource, "assets");
  const scripts = (await readdir(assets))
    .filter((name) => name.endsWith(".js"))
    .sort(compare);
  for (const script of scripts) {
    if (modulePreloadSignature.test(await readFile(join(assets, script), "utf8"))) return;
  }
  throw new Error("The copied dashboard does not contain the audited Vite modulepreload runtime");
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

async function runtimeClosure(cliMetafile, dashboardMetafile, overrides) {
  const workspaces = await workspacePackages();
  const thirdParty = new Map();
  const visited = new Set();
  const usedOverrides = new Set();

  async function visit(value, surface, options = {}) {
    const key = `${value.root}\0${surface}`;
    if (visited.has(key)) return;
    visited.add(key);
    const workspace = workspaces.get(value.manifest.name);
    const isWorkspace = workspace?.root === value.root && insideWorkspace(value.root);
    if (!isWorkspace) {
      const identifier = `${value.manifest.name}@${value.manifest.version}`;
      const existing = thirdParty.get(identifier) ?? {
        value,
        surfaces: new Set(),
        rationales: new Set()
      };
      existing.surfaces.add(surface);
      if (options.rationale) existing.rationales.add(options.rationale);
      thirdParty.set(identifier, existing);
    }
    if (options.traverseDependencies === false) return;
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
  const dashboardPackage = await packageAt(dashboardPackageDirectory);
  await visit(dashboardPackage, "dashboard-runtime");
  await visit(
    await resolveDependency("vite", dashboardPackage, workspaces),
    "dashboard-injected-runtime",
    {
      traverseDependencies: false,
      rationale: "Vite injects the modulepreload polyfill into the copied production dashboard JavaScript."
    }
  );

  const packages = [];
  for (const [identifier, entry] of [...thirdParty.entries()].sort(([left], [right]) => compare(left, right))) {
    const attributions = await licenseAttributions(
      identifier,
      entry.value.root,
      overrides,
      usedOverrides
    );
    packages.push({
      identifier,
      name: entry.value.manifest.name,
      version: entry.value.manifest.version,
      license: declaredLicense(entry.value.manifest),
      ...(sourceUrl(entry.value.manifest) ? { source: sourceUrl(entry.value.manifest) } : {}),
      surfaces: [...entry.surfaces].sort(compare),
      ...(
        entry.rationales.size > 0
          ? { rationale: [...entry.rationales].sort(compare).join(" ") }
          : {}
      ),
      attributions
    });
  }
  assertNoUnusedLicenseOverrides(overrides, usedOverrides);
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
    if (entry.rationale) lines.push(`Runtime rationale: ${entry.rationale}`);
    for (const attribution of entry.attributions) {
      lines.push("");
      lines.push(`Attribution: ${attribution.kind} ${attribution.source}`);
      if (attribution.reason) lines.push(`Audit reason: ${attribution.reason}`);
      lines.push("");
      lines.push(`### ${attribution.source}`);
      lines.push("");
      lines.push(attribution.text);
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
await assertViteModulePreloadRuntime();
const overrides = validateLicenseOverrides(await readJson(licenseOverridesPath));
const dependencies = await runtimeClosure(cliBuild.metafile, dashboardAnalysis.metafile, overrides);
const publicManifest = {
  schemaVersion: 1,
  packages: dependencies.map(({ identifier: _identifier, attributions, ...entry }) => ({
    ...entry,
    attributions: attributions.map(({ text: _text, ...attribution }) => attribution)
  }))
};
await writeFile(manifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`, "utf8");
await writeFile(noticesPath, renderNotices(dependencies), "utf8");
await cp(dashboardSource, dashboardDestination, { recursive: true });
await cp(integrationsSource, integrationsDestination, { recursive: true });
