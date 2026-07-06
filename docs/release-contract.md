# Release version and channel contract

[`release-contract.json`](../release-contract.json) is the reviewed source for Skill Steward's public version and release channel. It covers exactly seven packages: the CLI and six optional native no-replace helpers. Private workspace packages keep independent internal versions.

The current contract remains Alpha. It does not publish anything and does not claim that npm installation is available.

## Check the current contract

```bash
pnpm release:check
```

This read-only check validates semantic version/channel agreement, the exact public package set, every public manifest version, and all six CLI optional-dependency pins. `pnpm check` runs it before build, typecheck, or tests. Native build and protected publication jobs run the same check before packing or contacting npm.

## Prepare a version change

1. Edit only the intended version, channel, npm tag, and GitHub prerelease fields in `release-contract.json`.
2. Run the explicit synchronizer:

   ```bash
   pnpm release:sync
   ```

3. Review all seven manifest diffs and the six CLI optional-dependency pins.
4. Run `pnpm release:check`, the focused package tests, and then `CI=true pnpm check`.
5. Commit the contract and generated manifest mirrors together.

The synchronizer never runs from build, pack, test, or publication. It writes only the allow-listed public `version` fields and native dependency pins after the full repository topology passes validation.

## Allowed mappings

| Semantic version | Channel | npm tag | GitHub prerelease |
|---|---|---|---|
| `X.Y.Z-alpha.N` | `alpha` | `alpha` | `true` |
| `X.Y.Z-beta.N` | `beta` | `beta` | `true` |
| `X.Y.Z` | `stable` | `latest` | `false` |

Release candidates, custom prerelease labels, build metadata, mismatched tags, and unlisted public packages are rejected. Publication scripts consume the checked npm tag; they do not infer one from a branch, artifact filename, workflow input, or registry response.

## Trust boundary

The JSON contract cannot expand its own authority. The checker independently fixes the CLI and six native names and physical repository paths. A missing, renamed, extra, symlinked, or out-of-repository public package fails before synchronization or publication.

The contract does not replace the existing protected environment, exact-`main` requirement, artifact verification, byte-identity preflight, provenance, or one-time bootstrap controls described in [Native package publication](native-publication.md) and [CLI npm publication](cli-publication.md).
