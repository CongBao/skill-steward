import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("companion owned-tree native no-replace loader", () => {
  it.each(["missing", "unverified", "broken"] as const)(
    "fails closed for a %s current-platform helper package",
    async (scenario) => {
      const nativeModule = await import("../src/companion-owned-tree-native.js");
      const load = (nativeModule as unknown as Record<string, unknown>)
        .loadOwnedTreeNativeRenameBinding;
      expect(typeof load).toBe("function");
      const requirePackage = scenario === "missing"
        ? () => { throw new Error("package missing"); }
        : scenario === "broken"
          ? () => ({
              metadata: () => { throw new Error("metadata failed"); },
              renameNoReplace: () => 0
            })
        : () => ({
            metadata: () => "skill-steward.rename-noreplace.v0:darwin:arm64:none",
            renameNoReplace: () => 0
          });
      expect(() => (load as (input: unknown) => unknown)({
        platform: "darwin",
        arch: "arm64",
        libc: "none",
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
        requirePackage
      })).toThrow(expect.objectContaining({
        code: "INTEGRATION_CONFIGURATION_INVALID"
      }));
    }
  );

  it("accepts only the exact fd-relative mutation ABI", async () => {
    const { loadOwnedTreeNativeRenameBinding } = await import(
      "../src/companion-owned-tree-native.js"
    );
    const binding = {
      metadata: () => "skill-steward.owned-tree-native.v2:darwin:arm64:none",
      renameNoReplace: (_parentFd: number, _source: string, _destination: string) => 0,
      removeAt: (_parentFd: number, _name: string, _directory: boolean) => 0
    };
    expect(loadOwnedTreeNativeRenameBinding({
      platform: "darwin",
      arch: "arm64",
      libc: "none",
      runtimePlatform: "darwin",
      runtimeArch: "arm64",
      requirePackage: () => binding
    })).toBe(binding);
  });

  it("keeps owned-tree permission changes on verified file handles", async () => {
    const source = await readFile(
      new URL("../src/companion-owned-tree-proof.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("handle.chmod(");
    expect(source).not.toMatch(/\bchmod\(proof\.path,/);
  });
});
