import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("builds native packages on pull requests but publishes only reviewed main artifacts", async () => {
  const workflow = await readFile(
    resolve(process.cwd(), "../..", ".github/workflows/native-rename-packages.yml"),
    "utf8"
  );
  expect(workflow).toMatch(/\n  pull_request:\s*\n/);
  expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow).toContain("inputs.publish");
  expect(workflow).toContain("github.ref == 'refs/heads/main'");

  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  expect(publish).toMatch(/\n    needs: build\s*\n/);
  expect(publish).toMatch(/\n    environment: native-publish\s*\n/);
  expect(publish).toContain("pattern: rename-noreplace-*");
  expect(publish).toContain("merge-multiple: true");
  expect(publish).toContain("id-token: write");
  expect(publish).toContain("actions/checkout@");
  expect(publish).toContain("node scripts/publish-native-rename-packages.mjs artifacts/native/*.tgz");
  expect((workflow.match(/node scripts\/release-contract\.mjs check/g) ?? [])).toHaveLength(2);
  expect(publish).not.toContain("for artifact in artifacts/native/*.tgz");
  expect(workflow).toContain("authentication:");
  expect(workflow).toContain("trusted-publisher");
  expect(workflow).toContain("bootstrap-token");
  expect(publish).toContain("inputs.authentication == 'trusted-publisher'");
  expect(publish).toContain("inputs.authentication == 'bootstrap-token'");
  expect(publish).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
  expect(publish).toContain('test -n "$NODE_AUTH_TOKEN"');
  expect(publish.match(/secrets\.NPM_BOOTSTRAP_TOKEN/g) ?? []).toHaveLength(1);
  expect(publish).toContain("node-version: 22.22.1");
  expect(publish).toContain("npm install --global npm@11.17.0");
  expect(publish).toContain('test "$(npm --version)" = "11.17.0"');
  expect((workflow.match(/id-token: write/g) ?? [])).toHaveLength(1);

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
