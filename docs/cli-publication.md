# CLI npm publication

Skill Steward has a manual, protected CLI publication workflow, but the package has not been published yet. Adding this workflow does not publish anything, configure npm, or make `npm install --global skill-steward` available. The current public installation path remains the locally verified tarball in the README.

## Native packages come first

The CLI declares six optional native packages at the same release-contract version. Publish and verify all six through [Native package publication](native-publication.md) before attempting the CLI workflow. The CLI publisher checks every native version on the public registry and refuses before a CLI write if any one is missing or malformed.

## Verify without publishing

Run **CLI package publication** (`.github/workflows/cli-package-publication.yml`) manually with `publish: false`. The build job:

1. checks `release-contract.json`;
2. builds and packs exactly one CLI tarball;
3. compares it with the trusted checkout tree and locked runtime audit;
4. runs the publisher in network-free `--check-only` mode; and
5. retains the workflow artifact for one day.

No protected environment or npm credential is needed for this path.

## First publication only

npm trusted publishing can be configured only after the unscoped package name exists. Bootstrap `skill-steward` once:

1. Create a short-lived granular npm token limited to creation/publication of `skill-steward`. Enable publication bypass only if the npm account policy requires it.
2. Create a protected GitHub environment named `cli-publish` with required reviewers. Store the token as its `NPM_BOOTSTRAP_TOKEN` environment secret, never as a repository secret or local file.
3. Confirm the selected commit is exact `main`, the release contract is intentional, and the six matching native versions are already public.
4. Run **CLI package publication** with `publish: true` and `authentication: bootstrap-token`, then approve the environment deployment.
5. Require all Linux, macOS, and Windows registry-install jobs to pass. They install the exact public version into disposable prefix/state directories and exercise version, help, dashboard help, scan, Preflight, and the supported-platform native boundary.
6. Configure npm trusted publishing for package `skill-steward`, repository `CongBao/skill-steward`, workflow `cli-package-publication.yml`, and environment `cli-publish`.
7. Delete `NPM_BOOTSTRAP_TOKEN` and revoke the token immediately.

## Later publications

Use `authentication: trusted-publisher`. The protected job pins Node 22.22.1 and npm 11.17.0, receives a short-lived OIDC identity, verifies all native dependencies, and then handles the CLI registry state:

- a missing CLI version is published once with public access, the contract npm tag, and provenance;
- an existing byte-identical version is a successful no-op and still proceeds to registry acceptance;
- an existing different version, unverifiable response, or missing native dependency stops without a write.

The workflow is manual-only. Non-`main` refs can build and verify, but cannot enter `cli-publish` or run registry acceptance. Ordinary CI, local tests, packing, release checks, and `--check-only` never publish.

## Approval checklist

- Exact `main` commit and intended release contract.
- Six native packages already public at the same version.
- One verified CLI artifact and unchanged publication scripts/workflow.
- Protected-environment reviewer approval.
- Trusted publishing selected after bootstrap; no persistent token remains.
- All three registry-install platforms pass before changing README installation or release status.
