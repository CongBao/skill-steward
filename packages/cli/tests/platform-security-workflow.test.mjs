import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps named Windows and macOS platform-security gates in CI", async () => {
  const workflow = await readFile(
    resolve(process.cwd(), "../..", ".github/workflows/ci.yml"),
    "utf8"
  );
  expect(workflow).toContain("windows-security:");
  expect(workflow).toContain("runs-on: windows-latest");
  expect(workflow).toContain("tests/integration-store.windows.test.ts");
  expect(workflow).toContain("tests/integration-platform.windows.test.ts");
  expect(workflow).toContain("macos-security:");
  expect(workflow).toContain("runs-on: macos-15");
  expect(workflow).toContain("build-native-rename-noreplace.mjs darwin arm64 none");
  expect(workflow).toContain("tests/integration-process-crash.test.ts");
  expect(
    workflow.match(/name: Build integration workspace/g),
    "each platform-security job must build workspace dependencies before Vitest"
  ).toHaveLength(2);
  expect(
    workflow.match(
      /run: pnpm --filter @skill-steward\/integrations\.\.\. build/g
    )
  ).toHaveLength(2);
  expect(
    workflow.match(/name: Verify release contract/g),
    "every CI job must fail before packaging or building when release identity drifts"
  ).toHaveLength(3);

  const actions = [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s]+)/g)];
  expect(actions.length).toBeGreaterThan(0);
  for (const [, name, revision] of actions) {
    expect(revision, name).toMatch(/^[a-f0-9]{40}$/);
  }
});
