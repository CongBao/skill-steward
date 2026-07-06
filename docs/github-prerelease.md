# Attested GitHub prerelease

Skill Steward has a manual, protected workflow for publishing a GitHub prerelease from the exact seven tarballs already served by npm. The workflow is present but no GitHub prerelease is created by this repository change. npm installation and the README status remain unchanged until the public Beta run succeeds.

## What is published

The release contains exactly nine assets:

- the `skill-steward` CLI tarball served by npm;
- six platform-specific `@skill-steward/rename-noreplace-*` tarballs served by npm;
- canonical `release-manifest.json`; and
- `SHA256SUMS`, covering the seven tarballs and the manifest.

`release-manifest.json` binds each package name, role, version, deterministic filename, npm SHA-512 integrity, SHA-256 digest, byte size, repository, and exact source commit. Its fixed `provenanceScope` is `npm-registry-byte-assembly`: the commit identifies the assembly workflow and verifier source, not a claim that this job rebuilt native binaries. Release identity comes from the checked [`release-contract.json`](../release-contract.json). The GitHub tarballs are downloaded from the fixed public npm registry and are not rebuilt substitutes.

## Assembly without publication

All seven package versions must already be public on npm. Run **Attested GitHub prerelease** (`.github/workflows/github-prerelease.yml`) with `publish: false`. The assembly job:

1. binds `GITHUB_SHA` to the actual checkout and checks the release contract;
2. builds the trusted CLI tree used by the source-bound package verifier;
3. resolves all seven npm metadata records before downloading any tarball;
4. rejects redirects, alternate hosts, malformed SRI, oversized compressed or unpacked content, and package-shape drift;
5. creates the canonical manifest and sorted checksums in a staging directory;
6. verifies the exact nine-file directory offline; and
7. retains that workflow artifact for seven days so protected review can cross weekends without rebuilding the release set.

This path has read-only repository permission. It cannot create or update a GitHub Release.

## Protected publication

Create a GitHub environment named `github-release` with required reviewers. Then run the workflow from exact `main` with `publish: true` and approve that environment.

After the read-only assembly job performs the only dependency installation, build, and full package verification, two smaller jobs consume the same named artifact. The `attest` job has only `contents: read`, `id-token: write`, and `attestations: write`; it performs dependency-free envelope verification and runs the SHA-pinned official [`actions/attest`](https://github.com/actions/attest) action. The protected `publish` job has only `contents: write`, repeats envelope verification without installing dependencies, and can run only after attestation succeeds. Every checkout disables persisted credentials.

The attestation proves workflow provenance for the nine subject digests. It does not by itself prove that a later GitHub Release upload completed; downloaded Release assets must match those attested digests. It also does not claim that native binaries were rebuilt from source in this workflow. Before approving `github-release`, verify the seven npm provenance records name the same repository, publication workflow, and source commit. npm publication provenance remains the source for that separate build-origin claim.

## Draft recovery and conflicts

The publisher uses a fixed `CongBao/skill-steward` repository, tag `v<version>`, source commit, release name, changelog section, and prerelease flag. It creates a draft before the first upload, then uploads only missing assets from the bytes returned by offline verification.

A new draft is admitted only while its source commit is the current `main`. That admission is durable: if upload is interrupted or `main` advances later, a rerun resumes only the strictly matching partial draft rather than abandoning a recoverable release transaction. Existing assets must match by SHA-256 and size; older API responses without an asset digest are checked through one credential-free, approved GitHub CDN redirect. Duplicate releases, wrong tags, extra assets, metadata drift, and byte conflicts stop without deleting or overwriting anything. The draft becomes public only after a fresh exact-inventory check. An already published byte-identical release is a no-op even after `main` advances.

## Verify downloaded assets

From a checkout at the manifest's `sourceCommit`, place all nine downloaded files in one directory. Check hashes from inside that directory.

Linux:

```bash
(cd /path/to/release-assets && sha256sum --check SHA256SUMS)
```

macOS:

```bash
(cd /path/to/release-assets && shasum -a 256 --check SHA256SUMS)
```

PowerShell:

```powershell
Set-Location C:\path\to\release-assets
Get-Content SHA256SUMS | ForEach-Object {
  $hash, $name = $_ -split '  ', 2
  if ((Get-FileHash -Algorithm SHA256 $name).Hash.ToLowerInvariant() -ne $hash) {
    throw "Checksum mismatch: $name"
  }
}
```

Then run the source-bound package verifier from the checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter skill-steward... build
node scripts/verify-release-assets.mjs \
  --source-commit "$(git rev-parse HEAD)" \
  /path/to/release-assets
```

The offline verifier rejects missing, extra, linked, noncanonical, size-drifted, or digest-drifted assets and rechecks every CLI/native package against the source tree. GitHub's [artifact attestation verification documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-artifact-attestations) describes the supported verifier. If you use GitHub CLI for public artifact verification, the project-specific form is `gh attestation verify /path/to/release-assets/* --repo CongBao/skill-steward`; repository maintainers can instead use GitHub's linked attestation UI/API when local account selection makes CLI use undesirable.

## Approval order

1. Publish and verify all six native packages, including npm provenance bound to the intended source commit.
2. Publish and verify the CLI package and three-platform registry smoke tests.
3. Run GitHub assembly with `publish: false` and inspect the nine-file artifact.
4. Run exact-main publication, review the `github-release` environment request, and approve.
5. Verify checksums, offline package contracts, the GitHub attestation, tag target, and installation before changing README status or repository metadata.
