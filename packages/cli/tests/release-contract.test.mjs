import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkReleaseContract,
  parseReleaseContract,
  syncReleaseContract
} from "../../../scripts/release-contract.mjs";

const roots = [];
const publicPackages = [
  { name: "skill-steward", path: "packages/cli", role: "cli" },
  { name: "@skill-steward/rename-noreplace-darwin-arm64", path: "packages/rename-noreplace-darwin-arm64", role: "native" },
  { name: "@skill-steward/rename-noreplace-darwin-x64", path: "packages/rename-noreplace-darwin-x64", role: "native" },
  { name: "@skill-steward/rename-noreplace-linux-arm64-gnu", path: "packages/rename-noreplace-linux-arm64-gnu", role: "native" },
  { name: "@skill-steward/rename-noreplace-linux-arm64-musl", path: "packages/rename-noreplace-linux-arm64-musl", role: "native" },
  { name: "@skill-steward/rename-noreplace-linux-x64-gnu", path: "packages/rename-noreplace-linux-x64-gnu", role: "native" },
  { name: "@skill-steward/rename-noreplace-linux-x64-musl", path: "packages/rename-noreplace-linux-x64-musl", role: "native" }
];
const nativeNames = publicPackages.filter(({ role }) => role === "native").map(({ name }) => name);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function contract(version = "0.5.0-alpha.4", channel = "alpha") {
  return {
    schemaVersion: 1,
    version,
    channel,
    npmTag: channel === "stable" ? "latest" : channel,
    githubPrerelease: channel !== "stable",
    packages: publicPackages
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture({ manifestVersion = "0.5.0-alpha.4", dependencyVersion = manifestVersion } = {}) {
  const root = await mkdtemp(join(tmpdir(), "steward-release-contract-"));
  roots.push(root);
  await writeJson(join(root, "release-contract.json"), contract());
  await writeJson(join(root, "package.json"), { name: "workspace", version: "0.0.0", private: true });
  for (const item of publicPackages) {
    await writeJson(join(root, item.path, "package.json"), {
      name: item.name,
      version: manifestVersion,
      private: false,
      description: `preserve-${item.role}`,
      ...(item.role === "cli"
        ? { optionalDependencies: Object.fromEntries(nativeNames.map((name) => [name, dependencyVersion])) }
        : {})
    });
  }
  await writeJson(join(root, "packages/private-core/package.json"), {
    name: "@skill-steward/private-core", version: "0.0.0", private: true
  });
  await writeJson(join(root, "apps/dashboard/package.json"), {
    name: "@skill-steward/dashboard", version: "0.0.0", private: true
  });
  return root;
}

describe("release contract parsing", () => {
  it.each([
    ["0.5.0-alpha.4", "alpha", "alpha", true],
    ["0.5.0-beta.1", "beta", "beta", true],
    ["0.5.0", "stable", "latest", false]
  ])("accepts the %s release identity", (version, channel, npmTag, githubPrerelease) => {
    expect(parseReleaseContract({ ...contract(version, channel), npmTag, githubPrerelease }))
      .toMatchObject({ version, channel, npmTag, githubPrerelease });
  });

  it.each([
    [{ ...contract(), npmTag: "latest" }, "RELEASE_CHANNEL_MISMATCH"],
    [{ ...contract("0.5.0-beta.1", "beta"), githubPrerelease: false }, "RELEASE_CHANNEL_MISMATCH"],
    [{ ...contract("0.5.0-rc.1", "beta") }, "RELEASE_VERSION_INVALID"],
    [{ ...contract("0.5.0-alpha.04", "alpha") }, "RELEASE_VERSION_INVALID"],
    [{ ...contract(), extra: true }, "RELEASE_CONTRACT_KEYS_INVALID"],
    [{ ...contract(), packages: publicPackages.slice(0, -1) }, "RELEASE_PACKAGE_SET_INVALID"],
    [{ ...contract(), packages: [...publicPackages.slice(0, -1), { ...publicPackages.at(-1), path: "../outside" }] }, "RELEASE_PACKAGE_SET_INVALID"]
  ])("rejects an invalid contract without permissive fallback", (value, code) => {
    expect(() => parseReleaseContract(value)).toThrow(code);
  });
});

describe("release repository consistency", () => {
  it("accepts the real repository and excludes private workspace versions", () => {
    const checked = checkReleaseContract(resolve(process.cwd(), "../.."));
    expect(checked.version).toBe("0.5.0-alpha.4");
    expect(checked.packages).toHaveLength(7);
  });

  it("fails closed on version, dependency, and public package drift", async () => {
    const versionRoot = await fixture({ manifestVersion: "0.5.0-alpha.3" });
    expect(() => checkReleaseContract(versionRoot)).toThrow("RELEASE_MANIFEST_VERSION_DRIFT");

    const dependencyRoot = await fixture({ dependencyVersion: "0.5.0-alpha.3" });
    expect(() => checkReleaseContract(dependencyRoot)).toThrow("RELEASE_NATIVE_DEPENDENCY_DRIFT");

    const publicRoot = await fixture();
    await writeJson(join(publicRoot, "packages/private-core/package.json"), {
      name: "@skill-steward/unexpected-public", version: "0.5.0-alpha.4", private: false
    });
    expect(() => checkReleaseContract(publicRoot)).toThrow("RELEASE_PUBLIC_PACKAGE_SET_INVALID");

    const renamedRoot = await fixture();
    await writeJson(join(renamedRoot, "packages/cli/package.json"), {
      name: "renamed-cli",
      version: "0.5.0-alpha.4",
      private: false,
      optionalDependencies: Object.fromEntries(nativeNames.map((name) => [name, "0.5.0-alpha.4"]))
    });
    expect(() => checkReleaseContract(renamedRoot)).toThrow("RELEASE_PUBLIC_PACKAGE_SET_INVALID");

    const missingRoot = await fixture();
    await rm(join(missingRoot, "packages/rename-noreplace-darwin-arm64"), {
      recursive: true,
      force: true
    });
    expect(() => checkReleaseContract(missingRoot)).toThrow("RELEASE_PACKAGE_PATH_UNSAFE");
  });

  it("rejects duplicate public package identities instead of collapsing them", async () => {
    const root = await fixture();
    await writeJson(join(root, "packages/duplicate-cli/package.json"), {
      name: "skill-steward", version: "0.5.0-alpha.4", private: false
    });

    expect(() => checkReleaseContract(root)).toThrow("RELEASE_PUBLIC_PACKAGE_SET_INVALID");
  });

  it("rejects symlinked workspace package entries instead of skipping them", async () => {
    const root = await fixture();
    const outside = join(dirname(root), `${root.split("/").at(-1)}-linked-package`);
    roots.push(outside);
    await writeJson(join(outside, "package.json"), {
      name: "@skill-steward/hidden-public", version: "0.5.0-alpha.4", private: false
    });
    await symlink(outside, join(root, "packages/linked-package"), "dir");

    expect(() => checkReleaseContract(root)).toThrow("RELEASE_PACKAGE_PATH_UNSAFE");
  });

  it("rejects a symlinked package path before synchronization writes", async () => {
    const root = await fixture({ manifestVersion: "0.5.0-alpha.3" });
    const packagePath = join(root, "packages/rename-noreplace-darwin-arm64");
    const outside = join(dirname(root), `${root.split("/").at(-1)}-outside`);
    roots.push(outside);
    await rename(packagePath, outside);
    await symlink(outside, packagePath, "dir");

    await expect(syncReleaseContract(root)).rejects.toThrow("RELEASE_PACKAGE_PATH_UNSAFE");
    expect(JSON.parse(await readFile(join(outside, "package.json"), "utf8")).version)
      .toBe("0.5.0-alpha.3");
  });

  it("explicitly synchronizes only release mirrors and preserves unrelated metadata", async () => {
    const root = await fixture({ manifestVersion: "0.5.0-alpha.3", dependencyVersion: "0.5.0-alpha.2" });
    const changed = await syncReleaseContract(root);
    expect(changed).toEqual(publicPackages.map(({ path }) => `${path}/package.json`));
    expect(checkReleaseContract(root).version).toBe("0.5.0-alpha.4");

    const cli = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
    expect(cli.description).toBe("preserve-cli");
    expect(new Set(Object.values(cli.optionalDependencies))).toEqual(new Set(["0.5.0-alpha.4"]));
    expect(await readFile(join(root, "packages/cli/package.json"), "utf8"))
      .toBe(`${JSON.stringify(cli, null, 2)}\n`);
    expect(await syncReleaseContract(root)).toEqual([]);
  });
});
