# Native package publication

Skill Steward ships six optional native packages for no-replace filesystem operations. Pull requests and pushes build and verify every target, but publication is a separate manual job on the exact `main` ref. The `native-publish` GitHub environment must require reviewer approval. The publish job pins Node 22.22.1 and npm 11.17.0, then verifies the npm version before authentication so trusted publishing never depends on the runner's bundled npm client. Every build and publication run first validates [`release-contract.json`](../release-contract.json); the publisher accepts only that version and uses its checked npm tag.

## First publication only

npm trusted publishing can be configured only after a package exists. Bootstrap the six package names once with a short-lived granular npm token:

1. Create a granular token limited to the `@skill-steward` scope and package creation/publication. Give it the shortest practical expiry and enable npm's publication bypass only if the account policy requires it.
2. Store it as the `NPM_BOOTSTRAP_TOKEN` secret on the protected `native-publish` GitHub environment. Do not add it as a repository secret or local file.
3. From the `Native rename packages` workflow on `main`, choose `publish: true` and `authentication: bootstrap-token`. Approve the environment deployment only after checking the commit and all six build jobs.
4. Confirm all six packages and their provenance on npm.
5. Configure npm trusted publishing for each package with repository `CongBao/skill-steward`, workflow `native-rename-packages.yml`, and environment `native-publish`.
6. Delete the GitHub environment secret and revoke the bootstrap token immediately.

The publisher validates all six tarballs and all registry states before it publishes anything. A rerun skips byte-identical packages and refuses a package version whose registry integrity differs.

## Later publications

Use `authentication: trusted-publisher`. The job receives a short-lived OIDC identity through GitHub Actions and has no npm token. Keep `bootstrap-token` unused after the first publication; a missing environment secret makes that path fail closed.

Before approving any deployment, verify:

- the run uses the exact `main` ref;
- all six matrix builds and packed-tarball checks passed;
- the version, channel, and npm tag in `release-contract.json` are intentional and `pnpm release:check` passes;
- the workflow and first-party actions are unchanged or separately reviewed.
