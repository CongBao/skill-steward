import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps CLI publication manual, protected, exact-main, and registry-smoked", async () => {
  const root = resolve(process.cwd(), "../..");
  const workflow = await readFile(
    resolve(root, ".github/workflows/cli-package-publication.yml"),
    "utf8"
  );

  expect(workflow).toMatch(/on:\s*\n\s+workflow_dispatch:/u);
  expect(workflow).not.toMatch(/\n\s+push:/u);
  expect(workflow).not.toMatch(/\n\s+pull_request:/u);
  expect(workflow).toContain("publish:");
  expect(workflow).toContain("type: boolean");
  expect(workflow).toContain("authentication:");
  expect(workflow).toContain("trusted-publisher");
  expect(workflow).toContain("bootstrap-token");

  const publish = workflow.slice(workflow.indexOf("\n  publish:"), workflow.indexOf("\n  registry-smoke:"));
  expect(publish).toContain("needs: build");
  expect(publish).toContain("inputs.publish");
  expect(publish).toContain("github.ref == 'refs/heads/main'");
  expect(publish).toMatch(/\n    environment: cli-publish\s*\n/u);
  expect(publish).toContain("id-token: write");
  expect(publish).toContain("node-version: 22.22.1");
  expect(publish).toContain("pnpm install --frozen-lockfile");
  expect(publish).toContain("pnpm --filter skill-steward... build");
  expect(publish).toContain("npm install --global npm@11.17.0");
  expect(publish).toContain('test "$(npm --version)" = "11.17.0"');
  expect(publish).toContain("node scripts/publish-cli-package.mjs artifacts/cli/skill-steward-*.tgz");
  expect(publish.indexOf("pnpm --filter skill-steward... build"))
    .toBeLessThan(publish.indexOf("node scripts/publish-cli-package.mjs artifacts/cli/skill-steward-*.tgz"));
  expect(publish).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
  expect(publish).toContain('test -n "$NODE_AUTH_TOKEN"');
  expect(publish.match(/secrets\.NPM_BOOTSTRAP_TOKEN/gu) ?? []).toHaveLength(1);
  expect(workflow.match(/id-token: write/gu) ?? []).toHaveLength(1);

  const build = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  publish:"));
  expect(build).toContain("pnpm install --frozen-lockfile");
  expect(build).toContain("pnpm release:check");
  expect(build).toContain("pnpm --filter skill-steward pack --pack-destination artifacts/cli");
  expect(build).toContain("node scripts/verify-cli-package.mjs artifacts/cli/skill-steward-*.tgz");
  expect(build).toContain("node scripts/publish-cli-package.mjs --check-only artifacts/cli/skill-steward-*.tgz");
  expect(build).toContain("if-no-files-found: error");
  expect(build).toContain("retention-days: 1");

  const smoke = workflow.slice(workflow.indexOf("\n  registry-smoke:"));
  expect(smoke).toContain("needs: publish");
  expect(smoke).toContain("ubuntu-24.04");
  expect(smoke).toContain("macos-15");
  expect(smoke).toContain("windows-latest");
  expect(smoke).toContain("node scripts/verify-registry-install.mjs");
  expect(smoke).toContain("node-version: 22.22.1");
  expect(smoke).toContain("npm install --global npm@11.17.0");

  const ci = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).not.toContain("publish-cli-package.mjs");

  const actions = [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s]+)/gu)];
  expect(actions.length).toBeGreaterThan(0);
  for (const [, name, revision] of actions) {
    expect(revision, name).toMatch(/^[a-f0-9]{40}$/u);
  }
});
