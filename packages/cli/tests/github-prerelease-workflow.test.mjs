import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";

const officialAttest = "actions/attest@a1948c3f048ba23858d222213b7c278aabede763";

it("keeps GitHub prerelease assembly manual and publication protected, attested, and exact-main", async () => {
  const root = resolve(process.cwd(), "../..");
  const source = await readFile(resolve(root, ".github/workflows/github-prerelease.yml"), "utf8");
  const workflow = parse(source);

  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.on.workflow_dispatch.inputs.publish).toMatchObject({
    required: true,
    type: "boolean",
    default: false
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({
    group: "skill-steward-github-release-${{ github.ref }}",
    "cancel-in-progress": false
  });

  const assemble = workflow.jobs.assemble;
  expect(assemble["runs-on"]).toBe("ubuntu-24.04");
  expect(assemble["timeout-minutes"]).toBe(20);
  expect(assemble.permissions).toBeUndefined();
  const assembleRuns = assemble.steps.map((step) => step.run).filter(Boolean).join("\n");
  expect(assembleRuns).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  expect(assembleRuns).toContain("pnpm release:check");
  expect(assembleRuns).toContain("pnpm --filter skill-steward... build");
  expect(assembleRuns).toContain('node scripts/assemble-release-assets.mjs --source-commit "$GITHUB_SHA" --output artifacts/release');
  expect(assembleRuns).toContain('node scripts/verify-release-assets.mjs --source-commit "$GITHUB_SHA" artifacts/release');
  const upload = assemble.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload.with).toMatchObject({
    name: "skill-steward-release-${{ github.sha }}",
    path: "artifacts/release/*",
    "if-no-files-found": "error",
    "retention-days": 7
  });
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with, `${job.name ?? "job"} checkout`).toMatchObject({ "persist-credentials": false });
  }

  const attestJob = workflow.jobs.attest;
  expect(attestJob.needs).toBe("assemble");
  expect(attestJob.if).toContain("inputs.publish");
  expect(attestJob.if).toContain("github.ref == 'refs/heads/main'");
  expect(attestJob["timeout-minutes"]).toBe(10);
  expect(attestJob.permissions).toEqual({
    contents: "read",
    "id-token": "write",
    attestations: "write"
  });
  expect(attestJob.steps.filter((step) => step.uses === officialAttest)).toHaveLength(1);
  const attest = attestJob.steps.find((step) => step.uses === officialAttest);
  expect(attest.with["subject-path"]).toContain("artifacts/release/*.tgz");
  expect(attest.with["subject-path"]).toContain("artifacts/release/release-manifest.json");
  expect(attest.with["subject-path"]).toContain("artifacts/release/SHA256SUMS");
  expect(attestJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
    .toMatchObject({ "persist-credentials": false });
  const attestRuns = attestJob.steps.map((step) => step.run).filter(Boolean).join("\n");
  expect(attestRuns).toContain("verify-release-assets.mjs --envelope-only");
  expect(attestRuns).not.toContain("pnpm install");
  expect(attestRuns).not.toContain("pnpm --filter");

  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("attest");
  expect(publish.environment).toBe("github-release");
  expect(publish["timeout-minutes"]).toBe(10);
  expect(publish.permissions).toEqual({ contents: "write" });
  expect(publish.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
    .toMatchObject({ "persist-credentials": false });
  const publishRuns = publish.steps.map((step) => step.run).filter(Boolean).join("\n");
  expect(publishRuns).toContain("verify-release-assets.mjs --envelope-only");
  expect(publishRuns).not.toContain("pnpm install");
  expect(publishRuns).not.toContain("pnpm --filter");
  for (const job of [attestJob, publish]) {
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toEqual({
      name: "skill-steward-release-${{ github.sha }}",
      path: "artifacts/release"
    });
  }

  const verifyIndex = attestJob.steps.findIndex((step) => step.run?.includes("verify-release-assets.mjs"));
  const attestIndex = attestJob.steps.indexOf(attest);
  const releaseIndex = publish.steps.findIndex((step) => step.run?.includes("publish-github-release.mjs"));
  expect(verifyIndex).toBeGreaterThan(-1);
  expect(attestIndex).toBeGreaterThan(verifyIndex);
  expect(releaseIndex).toBeGreaterThan(-1);

  const actions = source.matchAll(/uses:\s*([^@\s]+)@([^\s]+)/gu);
  for (const [, name, revision] of actions) expect(revision, name).toMatch(/^[a-f0-9]{40}$/u);
  expect(source).not.toContain("secrets.");
  expect(source.match(/contents:\s*write/gu) ?? []).toHaveLength(1);
  expect(source.match(/id-token:\s*write/gu) ?? []).toHaveLength(1);
  expect(source.match(/attestations:\s*write/gu) ?? []).toHaveLength(1);

  const ci = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  expect(ci).not.toContain("publish-github-release.mjs");
});
