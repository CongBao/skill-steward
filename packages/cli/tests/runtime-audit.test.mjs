import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const fixturePackages = [{
  name: "example-runtime",
  version: "1.2.3",
  license: "MIT",
  source: "https://github.com/example/runtime",
  surfaces: ["cli-bundle"],
  attributions: [{
    kind: "file",
    source: "LICENSE",
    text: "Copyright Example\n\nPermission is hereby granted for this complete fixture license text."
      .padEnd(300, " ")
  }]
}];

it("creates and validates a complete generated runtime lock with full license digests", async () => {
  const audit = import("../runtime-audit.mjs");
  await expect(audit).resolves.toHaveProperty("createRuntimeAuditSnapshot");
  const {
    assertRuntimeAuditSnapshot,
    createRuntimeAuditSnapshot,
    validateRuntimeAuditSnapshot
  } = await audit;
  const notices = "# Third-Party Notices\n\ncomplete fixture\n";
  const snapshot = createRuntimeAuditSnapshot(fixturePackages, notices);
  expect(snapshot).toEqual({
    schemaVersion: 1,
    description: expect.stringMatching(/generated.*full runtime.*audit/i),
    noticesSha256: createHash("sha256").update(notices).digest("hex"),
    packages: [{
      name: "example-runtime",
      version: "1.2.3",
      license: "MIT",
      source: "https://github.com/example/runtime",
      surfaces: ["cli-bundle"],
      rationale: null,
      attributions: [{
        kind: "file",
        source: "LICENSE",
        reason: null,
        textSha256: createHash("sha256")
          .update(fixturePackages[0].attributions[0].text)
          .digest("hex")
      }]
    }]
  });
  expect(validateRuntimeAuditSnapshot(snapshot)).toEqual(snapshot);
  expect(() => assertRuntimeAuditSnapshot(snapshot, structuredClone(snapshot))).not.toThrow();
});

it("fails the full audit on missing, unused, field, or license-text drift", async () => {
  const { assertRuntimeAuditSnapshot, createRuntimeAuditSnapshot } = await import(
    "../runtime-audit.mjs"
  );
  const expected = createRuntimeAuditSnapshot(fixturePackages, "notices\n");
  const mutations = [
    (value) => value.packages.splice(0, 1),
    (value) => value.packages.push({ ...value.packages[0], name: "unused-runtime" }),
    (value) => { value.packages[0].source = "https://example.com/drift"; },
    (value) => { value.packages[0].attributions = [{}]; },
    (value) => { value.packages[0].attributions[0].textSha256 = "0".repeat(64); },
    (value) => { value.noticesSha256 = "f".repeat(64); }
  ];
  for (const mutate of mutations) {
    const actual = structuredClone(expected);
    mutate(actual);
    expect(() => assertRuntimeAuditSnapshot(actual, expected)).toThrow(/runtime audit.*drift/i);
  }
});

it("keeps the complete audit snapshot source-controlled and aligned with the generated manifest", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../runtime-audit.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(
    await readFile(new URL("../dist/third-party-manifest.json", import.meta.url), "utf8")
  );
  expect(snapshot.description).toMatch(/generated.*full runtime.*audit/i);
  expect(snapshot.packages).toHaveLength(manifest.packages.length);
  expect(snapshot.packages.length).toBeGreaterThan(6);
  expect(snapshot.packages.every((entry) => entry.attributions.every(
    (attribution) => /^[a-f0-9]{64}$/.test(attribution.textSha256)
  ))).toBe(true);
});
