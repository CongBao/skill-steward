import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

const checkout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const downloadArtifact = "actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53";
const setupNode = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";

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

  const publishJob = YAML.parse(workflow).jobs.publish;
  expect(Object.keys(publishJob).sort()).toEqual([
    "environment",
    "if",
    "needs",
    "permissions",
    "runs-on",
    "steps"
  ]);
  expect(publishJob.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(publishJob.steps).toEqual([
    {
      uses: checkout,
      with: { "persist-credentials": false }
    },
    {
      uses: setupNode,
      with: {
        "node-version": "22.22.1",
        "registry-url": "https://registry.npmjs.org"
      }
    },
    {
      uses: downloadArtifact,
      with: {
        name: "skill-steward-cli-${{ github.sha }}",
        path: "artifacts/cli"
      }
    },
    {
      uses: downloadArtifact,
      with: {
        name: "npm-publisher-client-${{ github.sha }}",
        path: "artifacts/npm-client"
      }
    },
    {
      name: "Verify and expose the pinned npm publisher client",
      run: [
        "node scripts/verify-pinned-npm-client.mjs artifacts/npm-client/npm-11.17.0.tgz",
        "tar -xzf artifacts/npm-client/npm-11.17.0.tgz -C artifacts/npm-client",
        'test "$(node artifacts/npm-client/package/bin/npm-cli.js --version)" = "11.17.0"',
        ""
      ].join("\n")
    },
    {
      name: "Publish with npm trusted publishing",
      if: "${{ inputs.authentication == 'trusted-publisher' }}",
      run: "node scripts/publish-cli-package.mjs --npm-cli artifacts/npm-client/package/bin/npm-cli.js --trusted-package-directory artifacts/cli/trusted-package-tree --workspace-root . artifacts/cli/skill-steward-*.tgz"
    },
    {
      name: "Bootstrap the package with the short-lived environment token",
      if: "${{ inputs.authentication == 'bootstrap-token' }}",
      env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_BOOTSTRAP_TOKEN }}" },
      run: [
        'test -n "$NODE_AUTH_TOKEN"',
        'export NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/skill-steward-bootstrap.npmrc"',
        "trap 'rm -f \"$NPM_CONFIG_USERCONFIG\"' EXIT",
        "printf '%s\\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > \"$NPM_CONFIG_USERCONFIG\"",
        "node scripts/publish-cli-package.mjs \\",
        "  --npm-cli artifacts/npm-client/package/bin/npm-cli.js \\",
        "  --trusted-package-directory artifacts/cli/trusted-package-tree \\",
        "  --workspace-root . \\",
        "  artifacts/cli/skill-steward-*.tgz",
        ""
      ].join("\n")
    }
  ]);

  const verifyStepIndex = publishJob.steps.findIndex(({ name }) => (
    name === "Verify and expose the pinned npm publisher client"
  ));
  const setupNodeStepIndex = publishJob.steps.findIndex(({ uses }) => uses === setupNode);
  expect(setupNodeStepIndex).toBeGreaterThanOrEqual(0);
  expect(setupNodeStepIndex).toBeLessThan(verifyStepIndex);
  const verifyRun = publishJob.steps[verifyStepIndex].run;
  expect(verifyRun.indexOf("verify-pinned-npm-client.mjs"))
    .toBeLessThan(verifyRun.indexOf("package/bin/npm-cli.js --version"));
  const publisherStepIndexes = publishJob.steps
    .map(({ run }, index) => String(run ?? "").includes("scripts/publish-cli-package.mjs") ? index : -1)
    .filter((index) => index >= 0);
  expect(publisherStepIndexes).toHaveLength(2);
  expect(publisherStepIndexes.every((index) => index > verifyStepIndex)).toBe(true);

  const publish = workflow.slice(workflow.indexOf("\n  publish:"), workflow.indexOf("\n  registry-smoke:"));
  expect(publish).toContain("needs: [build, prepare-publisher]");
  expect(publish).toContain("inputs.publish");
  expect(publish).toContain("github.ref == 'refs/heads/main'");
  expect(publish).toMatch(/\n    environment: cli-publish\s*\n/u);
  expect(publish).toContain("id-token: write");
  expect(publish).toMatch(/actions\/checkout@[^\n]+\n\s+with:\s*\n\s+persist-credentials: false/u);
  expect(publish).not.toContain("pnpm/action-setup@");
  expect(publish.match(/actions\/setup-node@/gu) ?? []).toHaveLength(1);
  expect(publish).not.toContain("pnpm install");
  expect(publish).not.toContain("pnpm --filter");
  expect(publish).not.toContain("npm install");
  expect(publish).not.toContain("npm pack");
  expect(publish).toContain("node scripts/verify-pinned-npm-client.mjs artifacts/npm-client/npm-11.17.0.tgz");
  expect(publish).toContain("node artifacts/npm-client/package/bin/npm-cli.js --version");
  expect(publish).toContain("--npm-cli artifacts/npm-client/package/bin/npm-cli.js");
  expect(publish).toContain("--trusted-package-directory artifacts/cli/trusted-package-tree");
  expect(publish).toContain("--workspace-root .");
  expect(publish).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
  expect(publish).toContain('test -n "$NODE_AUTH_TOKEN"');
  expect(publish).toContain("NPM_CONFIG_USERCONFIG");
  expect(publish).toContain("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}");
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
  expect(build).toContain("artifacts/cli/trusted-package-tree");
  expect(build).not.toContain("id-token: write");

  const prepare = workflow.slice(
    workflow.indexOf("\n  prepare-publisher:"),
    workflow.indexOf("\n  publish:")
  );
  expect(prepare).toContain("if: ${{ inputs.publish && github.ref == 'refs/heads/main' }}");
  expect(prepare).toContain("npm pack npm@11.17.0");
  expect(prepare).toContain("node scripts/verify-pinned-npm-client.mjs artifacts/npm-client/npm-11.17.0.tgz");
  expect(prepare).toContain("name: npm-publisher-client-${{ github.sha }}");
  expect(prepare).not.toContain("id-token: write");
  const prepareJob = YAML.parse(workflow).jobs["prepare-publisher"];
  expect(prepareJob.permissions).toBeUndefined();
  const prepareSetupNodeIndex = prepareJob.steps.findIndex(({ uses }) => uses === setupNode);
  const acquireClientIndex = prepareJob.steps.findIndex(({ name }) => (
    name === "Acquire the pinned npm publisher client without OIDC"
  ));
  const uploadClientIndex = prepareJob.steps.findIndex(({ with: options }) => (
    options?.name === "npm-publisher-client-${{ github.sha }}"
  ));
  expect(prepareJob.steps[prepareSetupNodeIndex].with).toEqual({
    "node-version": "22.22.1",
    "registry-url": "https://registry.npmjs.org"
  });
  expect(prepareJob.steps[acquireClientIndex].run).toBe([
    "mkdir -p artifacts/npm-client",
    "npm pack npm@11.17.0 --ignore-scripts --pack-destination artifacts/npm-client",
    "node scripts/verify-pinned-npm-client.mjs artifacts/npm-client/npm-11.17.0.tgz",
    ""
  ].join("\n"));
  expect(prepareSetupNodeIndex).toBeLessThan(acquireClientIndex);
  expect(acquireClientIndex).toBeLessThan(uploadClientIndex);

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
