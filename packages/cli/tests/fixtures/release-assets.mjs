import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkReleaseContract } from "../../../../scripts/release-contract.mjs";

const execFileAsync = promisify(execFile);

export async function createRegistryPackageFixture(repositoryRoot, fixtureRoot) {
  const release = checkReleaseContract(repositoryRoot);

  function filenameFor(name) {
    return `${name.replace(/^@/u, "").replace("/", "-")}-${release.version}.tgz`;
  }

  async function packPackage(item) {
    const output = join(fixtureRoot, "registry");
    const cache = join(fixtureRoot, "npm-cache");
    await Promise.all([
      mkdir(output, { recursive: true }),
      mkdir(cache, { recursive: true })
    ]);
    let bytes;
    if (item.role === "cli") {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
        {
          cwd: join(repositoryRoot, item.path),
          env: { ...process.env, npm_config_cache: cache },
          maxBuffer: 10 * 1024 * 1024
        }
      );
      const [{ filename }] = JSON.parse(stdout);
      bytes = await readFile(join(output, filename));
    } else {
      const parent = join(fixtureRoot, "native", item.name.replaceAll("/", "-").replace(/^@/u, ""));
      const packageRoot = join(parent, "package");
      await mkdir(packageRoot, { recursive: true });
      await Promise.all([
        writeFile(join(packageRoot, "package.json"), await readFile(join(repositoryRoot, item.path, "package.json"))),
        writeFile(join(packageRoot, "README.md"), await readFile(join(repositoryRoot, item.path, "README.md"))),
        writeFile(join(packageRoot, "LICENSE"), "MIT License\n"),
        writeFile(join(packageRoot, "rename_noreplace.node"), `fixture-${item.name}`)
      ]);
      const artifact = join(output, filenameFor(item.name));
      await execFileAsync("tar", [
        "-czf",
        artifact,
        "-C",
        parent,
        "package/LICENSE",
        "package/README.md",
        "package/package.json",
        "package/rename_noreplace.node"
      ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      bytes = await readFile(artifact);
    }
    return {
      ...item,
      bytes,
      filename: filenameFor(item.name),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      tarball: `https://registry.npmjs.org/${encodeURIComponent(item.name)}/-/${filenameFor(item.name)}`
    };
  }

  let sourceCommit;
  ({ stdout: sourceCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  }));
  sourceCommit = sourceCommit.trim();
  const packages = [];
  for (const item of release.packages) packages.push(await packPackage(item));

  function registryFetch(callLog, transformMetadata = (value) => value) {
    return async (url, options) => {
      callLog.push({ url: String(url), options });
      const metadata = packages.find((item) => (
        String(url) === `https://registry.npmjs.org/${encodeURIComponent(item.name)}/${release.version}`
      ));
      if (metadata) {
        return new Response(JSON.stringify(transformMetadata({
          name: metadata.name,
          version: release.version,
          dist: { tarball: metadata.tarball, integrity: metadata.integrity }
        }, metadata)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const artifact = packages.find((item) => item.tarball === String(url));
      if (artifact) {
        return new Response(artifact.bytes, {
          status: 200,
          headers: { "content-length": String(artifact.bytes.length) }
        });
      }
      return new Response("not found", { status: 404 });
    };
  }

  return { release, sourceCommit, packages, registryFetch };
}
