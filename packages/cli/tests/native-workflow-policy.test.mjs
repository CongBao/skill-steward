import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

const checkout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const downloadArtifact = "actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53";
const setupNode = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";

it("builds native packages on pull requests but publishes only reviewed main artifacts", async () => {
  const workflow = await readFile(
    resolve(process.cwd(), "../..", ".github/workflows/native-rename-packages.yml"),
    "utf8"
  );
  expect(workflow).toMatch(/\n  pull_request:\s*\n/);
  expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow).toContain("inputs.publish");
  expect(workflow).toContain("github.ref == 'refs/heads/main'");

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
      name: "Verify release contract",
      run: "node scripts/release-contract.mjs check"
    },
    {
      uses: downloadArtifact,
      with: {
        pattern: "rename-noreplace-*",
        path: "artifacts/native",
        "merge-multiple": true
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
      run: "node scripts/publish-native-rename-packages.mjs --npm-cli artifacts/npm-client/package/bin/npm-cli.js artifacts/native/*.tgz"
    },
    {
      name: "Bootstrap packages with the short-lived environment token",
      if: "${{ inputs.authentication == 'bootstrap-token' }}",
      env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_BOOTSTRAP_TOKEN }}" },
      run: [
        'test -n "$NODE_AUTH_TOKEN"',
        'export NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/skill-steward-bootstrap.npmrc"',
        "trap 'rm -f \"$NPM_CONFIG_USERCONFIG\"' EXIT",
        "printf '%s\\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > \"$NPM_CONFIG_USERCONFIG\"",
        "node scripts/publish-native-rename-packages.mjs \\",
        "  --npm-cli artifacts/npm-client/package/bin/npm-cli.js \\",
        "  artifacts/native/*.tgz",
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
    .map(({ run }, index) => String(run ?? "").includes("scripts/publish-native-rename-packages.mjs") ? index : -1)
    .filter((index) => index >= 0);
  expect(publisherStepIndexes).toHaveLength(2);
  expect(publisherStepIndexes.every((index) => index > verifyStepIndex)).toBe(true);

  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  expect(publish).toContain("needs: [build, prepare-publisher]");
  expect(publish).toMatch(/\n    environment: native-publish\s*\n/);
  expect(publish).toContain("pattern: rename-noreplace-*");
  expect(publish).toContain("merge-multiple: true");
  expect(publish).toContain("id-token: write");
  expect(publish).toMatch(/actions\/checkout@[^\n]+\n\s+with:\s*\n\s+persist-credentials: false/u);
  expect(publish.match(/actions\/setup-node@/gu) ?? []).toHaveLength(1);
  expect(publish).not.toContain("npm install");
  expect(publish).not.toContain("npm pack");
  expect(publish).not.toContain("pnpm install");
  expect(publish).toContain("node scripts/verify-pinned-npm-client.mjs artifacts/npm-client/npm-11.17.0.tgz");
  expect(publish).toContain("node artifacts/npm-client/package/bin/npm-cli.js --version");
  expect(publish).toContain("--npm-cli artifacts/npm-client/package/bin/npm-cli.js");
  expect((workflow.match(/node scripts\/release-contract\.mjs check/g) ?? [])).toHaveLength(2);
  expect(publish).not.toContain("for artifact in artifacts/native/*.tgz");
  expect(workflow).toContain("authentication:");
  expect(workflow).toContain("trusted-publisher");
  expect(workflow).toContain("bootstrap-token");
  expect(publish).toContain("inputs.authentication == 'trusted-publisher'");
  expect(publish).toContain("inputs.authentication == 'bootstrap-token'");
  expect(publish).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
  expect(publish).toContain('test -n "$NODE_AUTH_TOKEN"');
  expect(publish).toContain("NPM_CONFIG_USERCONFIG");
  expect(publish).toContain("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}");
  expect(publish.match(/secrets\.NPM_BOOTSTRAP_TOKEN/g) ?? []).toHaveLength(1);
  expect((workflow.match(/id-token: write/g) ?? [])).toHaveLength(1);

  const prepare = workflow.slice(
    workflow.indexOf("\n  prepare-publisher:"),
    workflow.indexOf("\n  publish:")
  );
  expect(prepare).toContain("github.event_name == 'workflow_dispatch'");
  expect(prepare).toContain("inputs.publish");
  expect(prepare).toContain("github.ref == 'refs/heads/main'");
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

  const actions = [...workflow.matchAll(/uses:\s*(actions\/[^@\s]+)@([^\s]+)/g)];
  expect(actions.length).toBeGreaterThan(0);
  for (const [, name, revision] of actions) {
    expect(revision, name).toMatch(/^[a-f0-9]{40}$/);
  }

  const publisher = await readFile(
    resolve(process.cwd(), "../..", "scripts/publish-native-rename-packages.mjs"),
    "utf8"
  );
  expect(publisher).toContain("Expected exactly six native package tarballs");
  expect(publisher).toContain("dist.integrity");
  expect(publisher).toContain("Published ${spec} exists with different bytes; refusing to continue");
  expect(publisher).toMatch(/E404/);
  expect(publisher).toContain('"--tag"');
  expect(publisher).toContain("release.npmTag");
  expect(publisher).not.toMatch(/["']alpha["']/u);
  expect(publisher.indexOf("checkReleaseContract"))
    .toBeLessThan(publisher.indexOf("runNpm([\"view\""));
  expect(publisher).toContain('"--provenance"');
  expect(publisher).toContain("https://registry.npmjs.org");
});
